"""
Speaker Diarization System
Uses VAD to extract voiced segments, ECAPA embeddings, and clustering to label speakers.
"""

import os
import sys
import logging
import tempfile
import warnings
import numpy as np
from typing import List, Tuple, Dict, Optional
from pathlib import Path
import torch
import torchaudio
from sklearn.cluster import KMeans, AgglomerativeClustering
import librosa

# Initialize logger first
logger = logging.getLogger(__name__)

# Fix Windows symlink issue: Use COPY strategy instead of SYMLINK on Windows
# This prevents the "A required privilege is not held by the client" error
if sys.platform == "win32":
    os.environ["SPEECHBRAIN_LOCAL_STRATEGY"] = "copy"

# Import SpeechBrain with fallback for different versions
try:
    # SpeechBrain 1.0+ uses inference module
    from speechbrain.inference.speaker import EncoderClassifier
except ImportError:
    try:
        # SpeechBrain 0.5.x uses pretrained module
        from speechbrain.pretrained import EncoderClassifier
    except ImportError:
        # If neither works, try direct import
        import speechbrain
        EncoderClassifier = None
        logger.warning("Could not import EncoderClassifier from SpeechBrain. Speaker diarization will be disabled.")

# Global ECAPA model (lazy loaded)
_ecapa_model: Optional[EncoderClassifier] = None


def get_ecapa_model():
    """Lazy load ECAPA-TDNN speaker embedding model"""
    global _ecapa_model
    if EncoderClassifier is None:
        raise RuntimeError("EncoderClassifier not available. Please install SpeechBrain correctly.")
    
    if _ecapa_model is None:
        logger.info("Loading ECAPA-TDNN speaker embedding model...")
        
        # On Windows, skip savedir to avoid symlink privilege issues
        # Use HuggingFace cache directly instead
        use_savedir = sys.platform != "win32"
        savedir = "pretrained_models/spkrec-ecapa-voxceleb" if use_savedir else None
        
        try:
            # Get device preference (check USE_GPU env var or default to GPU if available)
            use_gpu_env = os.getenv("USE_GPU", "").lower()
            prefer_gpu = use_gpu_env in ("true", "1", "yes", "cuda") if use_gpu_env else None
            
            # Detect GPU availability
            try:
                import torch
                if prefer_gpu is None:
                    # Auto-detect: use GPU if available
                    device = "cuda" if torch.cuda.is_available() else "cpu"
                elif prefer_gpu:
                    # User wants GPU - check if available
                    device = "cuda" if torch.cuda.is_available() else "cpu"
                    if device == "cpu":
                        logger.warning("GPU requested but not available - using CPU for speaker diarization")
                else:
                    # User wants CPU
                    device = "cpu"
                
                if device == "cuda":
                    logger.info(f"Using GPU for speaker diarization: {torch.cuda.get_device_name(0)}")
            except ImportError:
                device = "cpu"
                if prefer_gpu:
                    logger.warning("GPU requested but PyTorch not available - using CPU for speaker diarization")
            
            # Try new API first (1.0+)
            try:
                if savedir:
                    _ecapa_model = EncoderClassifier.from_hparams(
                        source="speechbrain/spkrec-ecapa-voxceleb",
                        savedir=savedir,
                        run_opts={"device": device}
                    )
                else:
                    # Windows: Load directly from HuggingFace cache (no savedir = no symlinks)
                    logger.info(f"Loading from HuggingFace cache (skipping local savedir to avoid Windows symlink issues) on {device}")
                    _ecapa_model = EncoderClassifier.from_hparams(
                        source="speechbrain/spkrec-ecapa-voxceleb",
                        run_opts={"device": device}
                    )
                    logger.info("ECAPA-TDNN model loaded from HuggingFace cache")
            except (OSError, RuntimeError) as e:
                # If savedir was used and failed, try without savedir
                if savedir and ("symlink" in str(e).lower() or "privilege" in str(e).lower() or "1314" in str(e)):
                    logger.warning("Symlink creation failed. Trying to load from HuggingFace cache directly...")
                    try:
                        _ecapa_model = EncoderClassifier.from_hparams(
                            source="speechbrain/spkrec-ecapa-voxceleb",
                            run_opts={"device": "cpu"}
                        )
                        logger.info("ECAPA-TDNN model loaded from HuggingFace cache (fallback)")
                    except Exception as e2:
                        logger.error(f"Failed to load ECAPA model from cache: {str(e2)}")
                        raise RuntimeError(
                            f"Failed to load ECAPA model. Symlink creation requires admin privileges on Windows. "
                            f"Error: {str(e)}. "
                            f"Alternative: Enable Windows Developer Mode or run as administrator."
                        )
                else:
                    # Fallback to older API (0.5.x) for non-Windows or other errors
                    try:
                        _ecapa_model = EncoderClassifier.from_hparams(
                            source="speechbrain/spkrec-ecapa-voxceleb",
                            savedir=savedir if savedir else None
                        )
                    except Exception as e2:
                        logger.error(f"Failed to load ECAPA model with fallback: {str(e2)}")
                        raise RuntimeError(f"Failed to load ECAPA model: {str(e)}")
            except Exception as e:
                # Fallback to older API (0.5.x)
                try:
                    _ecapa_model = EncoderClassifier.from_hparams(
                        source="speechbrain/spkrec-ecapa-voxceleb",
                        savedir=savedir if savedir else None
                    )
                except Exception as e2:
                    logger.error(f"Failed to load ECAPA model: {str(e2)}")
                    raise RuntimeError(f"Failed to load ECAPA model: {str(e)}")
            
            logger.info("ECAPA-TDNN model loaded successfully")
        except RuntimeError:
            # Re-raise RuntimeError as-is
            raise
        except Exception as e:
            logger.error(f"Failed to load ECAPA model: {str(e)}")
            raise RuntimeError(f"Failed to load ECAPA model: {str(e)}")
    return _ecapa_model


def segment_audio_vad(
    audio_path: str,
    sample_rate: int = 16000,
    frame_duration_ms: int = 30,
    energy_threshold: float = 0.01,
    min_speech_duration_ms: int = 250,
    min_silence_duration_ms: int = 100
) -> List[Tuple[float, float]]:
    """
    Extract voiced segments using simple energy-based VAD.
    
    Args:
        audio_path: Path to audio file
        sample_rate: Target sample rate
        frame_duration_ms: Frame duration in milliseconds
        energy_threshold: Energy threshold for speech detection
        min_speech_duration_ms: Minimum speech segment duration
        min_silence_duration_ms: Minimum silence duration to split segments
    
    Returns:
        List of (start_time, end_time) tuples in seconds
    """
    try:
        # Check file extension - soundfile only supports WAV, FLAC, OGG, etc. (not WebM)
        audio_ext = Path(audio_path).suffix.lower()
        soundfile_formats = {'.wav', '.flac', '.ogg', '.aiff', '.au'}
        
        # Use soundfile for supported formats, librosa for others (WebM, MP3, etc.)
        if audio_ext in soundfile_formats:
            try:
                import soundfile as sf
                audio, sr = sf.read(audio_path)
                # Convert to mono if needed
                if len(audio.shape) > 1:
                    audio = np.mean(audio, axis=1)
                # Resample if needed
                if sr != sample_rate:
                    audio = librosa.resample(audio, orig_sr=sr, target_sr=sample_rate)
                    sr = sample_rate
            except Exception as e:
                # Fallback to librosa if soundfile fails even for supported formats
                logger.debug(f"SoundFile failed for {audio_ext}, using librosa.load: {e}")
                with warnings.catch_warnings():
                    warnings.filterwarnings("ignore", category=FutureWarning)
                    warnings.filterwarnings("ignore", message=".*audioread.*", category=UserWarning)
                    warnings.filterwarnings("ignore", message=".*PySoundFile.*", category=UserWarning)
                    audio, sr = librosa.load(audio_path, sr=sample_rate, mono=True)
        else:
            # For WebM, MP3, and other formats, use librosa directly
            with warnings.catch_warnings():
                warnings.filterwarnings("ignore", category=FutureWarning)
                warnings.filterwarnings("ignore", message=".*audioread.*", category=UserWarning)
                warnings.filterwarnings("ignore", message=".*PySoundFile.*", category=UserWarning)
                audio, sr = librosa.load(audio_path, sr=sample_rate, mono=True)
        duration = len(audio) / sr
        
        # Calculate frame size
        frame_size = int(sample_rate * frame_duration_ms / 1000)
        frames = []
        
        # Calculate energy for each frame
        for i in range(0, len(audio) - frame_size, frame_size):
            frame = audio[i:i + frame_size]
            energy = np.sqrt(np.mean(frame ** 2))
            time = i / sample_rate
            frames.append((time, energy))
        
        # Detect speech segments
        segments = []
        in_speech = False
        speech_start = None
        min_frames_speech = int(min_speech_duration_ms / frame_duration_ms)
        min_frames_silence = int(min_silence_duration_ms / frame_duration_ms)
        
        silence_count = 0
        speech_count = 0
        
        for time, energy in frames:
            if energy > energy_threshold:
                silence_count = 0
                if not in_speech:
                    speech_start = time
                    in_speech = True
                    speech_count = 1
                else:
                    speech_count += 1
            else:
                speech_count = 0
                if in_speech:
                    silence_count += 1
                    if silence_count >= min_frames_silence:
                        # End of speech segment
                        if speech_start is not None and (time - speech_start) >= (min_speech_duration_ms / 1000):
                            segments.append((speech_start, time))
                        in_speech = False
                        silence_count = 0
                else:
                    silence_count += 1
        
        # Handle case where speech continues to end of audio
        if in_speech and speech_start is not None:
            segments.append((speech_start, duration))
        
        logger.info(f"VAD extracted {len(segments)} speech segments from {duration:.2f}s audio")
        return segments
        
    except Exception as e:
        logger.error(f"VAD segmentation failed: {str(e)}", exc_info=True)
        raise


def extract_speaker_embeddings(
    audio_path: str,
    segments: List[Tuple[float, float]],
    sample_rate: int = 16000
) -> Tuple[np.ndarray, List[Tuple[float, float]]]:
    """
    Extract ECAPA embeddings for each speech segment.
    
    Args:
        audio_path: Path to audio file
        segments: List of (start_time, end_time) tuples
        sample_rate: Audio sample rate
    
    Returns:
        Tuple of (embeddings array, valid_segments)
    """
    try:
        model = get_ecapa_model()
        
        # Check file extension - soundfile only supports WAV, FLAC, OGG, etc. (not WebM)
        audio_ext = Path(audio_path).suffix.lower()
        soundfile_formats = {'.wav', '.flac', '.ogg', '.aiff', '.au'}
        
        # Use soundfile for supported formats, librosa for others (WebM, MP3, etc.)
        if audio_ext in soundfile_formats:
            try:
                import soundfile as sf
                audio, sr = sf.read(audio_path)
                # Convert to mono if needed
                if len(audio.shape) > 1:
                    audio = np.mean(audio, axis=1)
                # Resample if needed
                if sr != sample_rate:
                    audio = librosa.resample(audio, orig_sr=sr, target_sr=sample_rate)
                    sr = sample_rate
            except Exception as e:
                # Fallback to librosa if soundfile fails even for supported formats
                logger.debug(f"SoundFile failed for {audio_ext}, using librosa.load: {e}")
                with warnings.catch_warnings():
                    warnings.filterwarnings("ignore", category=FutureWarning)
                    warnings.filterwarnings("ignore", message=".*audioread.*", category=UserWarning)
                    warnings.filterwarnings("ignore", message=".*PySoundFile.*", category=UserWarning)
                    audio, sr = librosa.load(audio_path, sr=sample_rate, mono=True)
        else:
            # For WebM, MP3, and other formats, use librosa directly
            with warnings.catch_warnings():
                warnings.filterwarnings("ignore", category=FutureWarning)
                warnings.filterwarnings("ignore", message=".*audioread.*", category=UserWarning)
                warnings.filterwarnings("ignore", message=".*PySoundFile.*", category=UserWarning)
                audio, sr = librosa.load(audio_path, sr=sample_rate, mono=True)
        
        embeddings = []
        valid_segments = []
        
        for start_time, end_time in segments:
            # Extract segment
            start_sample = int(start_time * sample_rate)
            end_sample = int(end_time * sample_rate)
            segment_audio = audio[start_sample:end_sample]
            
            # Skip segments that are too short (less than 0.5 seconds)
            if len(segment_audio) < sample_rate * 0.5:
                continue
            
            # Convert to tensor
            audio_tensor = torch.tensor(segment_audio).unsqueeze(0)
            
            # Extract embedding
            with torch.no_grad():
                embedding = model.encode_batch(audio_tensor)
                embedding_np = embedding.squeeze().cpu().numpy()
            
            embeddings.append(embedding_np)
            valid_segments.append((start_time, end_time))
        
        if len(embeddings) == 0:
            logger.warning("No valid segments for embedding extraction")
            return np.array([]), []
        
        embeddings_array = np.vstack(embeddings)
        logger.info(f"Extracted {len(embeddings)} speaker embeddings")
        
        return embeddings_array, valid_segments
        
    except Exception as e:
        logger.error(f"Embedding extraction failed: {str(e)}", exc_info=True)
        raise


def cluster_speakers(
    embeddings: np.ndarray,
    num_speakers: Optional[int] = None,
    method: str = "kmeans"
) -> np.ndarray:
    """
    Cluster speaker embeddings to identify different speakers.
    
    Args:
        embeddings: Array of speaker embeddings (n_segments, embedding_dim)
        num_speakers: Number of speakers (if None, auto-detect)
        method: Clustering method ("kmeans" or "agglomerative")
    
    Returns:
        Array of speaker labels (0, 1, 2, ...)
    """
    if len(embeddings) == 0:
        return np.array([])
    
    if len(embeddings) == 1:
        return np.array([0])
    
    # Auto-detect number of speakers if not provided
    if num_speakers is None:
        # Use simple heuristic: try 2-5 speakers, pick best silhouette score
        from sklearn.metrics import silhouette_score
        best_score = -1
        best_n = 2
        
        for n in range(2, min(6, len(embeddings) + 1)):
            try:
                kmeans = KMeans(n_clusters=n, random_state=42, n_init=10)
                labels = kmeans.fit_predict(embeddings)
                score = silhouette_score(embeddings, labels)
                if score > best_score:
                    best_score = score
                    best_n = n
            except:
                continue
        
        num_speakers = best_n
        logger.info(f"Auto-detected {num_speakers} speakers")
    
    # Perform clustering
    if method == "kmeans":
        clusterer = KMeans(n_clusters=num_speakers, random_state=42, n_init=10)
    else:  # agglomerative
        clusterer = AgglomerativeClustering(n_clusters=num_speakers)
    
    labels = clusterer.fit_predict(embeddings)
    
    logger.info(f"Clustered {len(embeddings)} segments into {num_speakers} speakers")
    return labels


def diarize_audio(
    audio_path: str,
    num_speakers: Optional[int] = None,
    sample_rate: int = 16000
) -> List[Dict[str, any]]:
    """
    Complete speaker diarization pipeline:
    1. VAD to extract voiced segments
    2. ECAPA embeddings for each segment
    3. Clustering to identify speakers
    4. Label speakers
    
    Args:
        audio_path: Path to audio file
        num_speakers: Number of speakers (None for auto-detect)
        sample_rate: Audio sample rate
    
    Returns:
        List of dicts with keys: start_time, end_time, speaker_label, speaker_id
    """
    try:
        # Step 1: VAD segmentation
        logger.info("Step 1: Extracting voiced segments with VAD...")
        segments = segment_audio_vad(audio_path, sample_rate=sample_rate)
        
        if len(segments) == 0:
            logger.warning("No speech segments detected")
            return []
        
        # Step 2: Extract embeddings
        logger.info("Step 2: Extracting speaker embeddings...")
        embeddings, valid_segments = extract_speaker_embeddings(
            audio_path, segments, sample_rate=sample_rate
        )
        
        if len(embeddings) == 0:
            logger.warning("No embeddings extracted")
            return []
        
        # Step 3: Cluster speakers
        logger.info("Step 3: Clustering speaker embeddings...")
        speaker_labels = cluster_speakers(embeddings, num_speakers=num_speakers)
        
        # Step 4: Create diarization results
        results = []
        for i, (start_time, end_time) in enumerate(valid_segments):
            speaker_id = int(speaker_labels[i])
            speaker_label = f"Speaker {speaker_id + 1}"
            
            results.append({
                "start_time": round(start_time, 2),
                "end_time": round(end_time, 2),
                "duration": round(end_time - start_time, 2),
                "speaker_id": speaker_id,
                "speaker_label": speaker_label
            })
        
        logger.info(f"Diarization complete: {len(results)} segments, {len(set(speaker_labels))} speakers")
        return results
        
    except Exception as e:
        logger.error(f"Speaker diarization failed: {str(e)}", exc_info=True)
        raise

