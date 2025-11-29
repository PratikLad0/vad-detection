# GPU Setup Guide for NVIDIA RTX 3050

This guide will help you configure GPU acceleration for faster processing.

## Prerequisites

1. **NVIDIA RTX 3050** (8GB VRAM) - ✅ You have this
2. **CUDA Toolkit 11.8 or 12.1+**
3. **NVIDIA GPU Drivers** (latest compatible with CUDA)
4. **cuDNN** (included with CUDA)

## Step 1: Verify GPU and CUDA

```bash
# Check GPU
nvidia-smi

# Check CUDA (if installed)
nvcc --version
```

## Step 2: Install CUDA-Enabled PyTorch

**IMPORTANT**: Uninstall current PyTorch first, then install CUDA version.

```bash
# Uninstall current PyTorch
pip uninstall torch torchvision torchaudio

# Install PyTorch with CUDA support (choose based on your CUDA version):

# For CUDA 12.4 (latest, recommended if you have CUDA 12.4)
# Note: PyTorch may use cu121 wheels which are backward compatible with CUDA 12.4
pip install torch torchvision torchaudio --index-url https://download.pytorch.org/whl/cu121

# OR explicitly for CUDA 12.1
pip install torch torchvision torchaudio --index-url https://download.pytorch.org/whl/cu121

# OR for CUDA 11.8 (older, but widely compatible)
pip install torch torchvision torchaudio --index-url https://download.pytorch.org/whl/cu118
```

## Step 3: Verify CUDA Installation

```python
python -c "import torch; print(f'CUDA available: {torch.cuda.is_available()}'); print(f'CUDA device: {torch.cuda.get_device_name(0) if torch.cuda.is_available() else \"N/A\"}'); print(f'CUDA version: {torch.version.cuda if torch.cuda.is_available() else \"N/A\"}')"
```

Expected output:
```
CUDA available: True
CUDA device: NVIDIA GeForce RTX 3050
CUDA version: 12.4  # or 12.1, 11.8 depending on your installation
```

## Step 4: Configure Environment Variables

Update your `.env` file:

```env
# Enable GPU for HuggingFace models
HF_DEVICE=cuda

# Optional: Use larger Whisper model with GPU (base or small)
WHISPER_MODEL=base
```

## Step 5: Restart Backend

The backend will automatically detect and use GPU for:
- ✅ Whisper transcription (automatic if CUDA available)
- ✅ Speaker diarization (ECAPA model)
- ✅ HuggingFace chatbot models

## Performance Improvements

With RTX 3050 (8GB VRAM), you can expect:

| Component | CPU Time | GPU Time | Speedup |
|-----------|----------|---------|---------|
| Whisper (base) | ~2-3s | ~0.5-1s | 2-3x |
| Speaker Diarization | ~1-2s | ~0.3-0.5s | 3-4x |
| HuggingFace Chatbot | ~1-2s | ~0.2-0.5s | 2-4x |

## Troubleshooting

### CUDA Not Available

**Problem**: `torch.cuda.is_available()` returns `False`

**Solutions**:
1. Verify GPU drivers: `nvidia-smi`
2. Check CUDA installation: `nvcc --version`
3. Reinstall PyTorch with CUDA support
4. Ensure CUDA version matches PyTorch CUDA version

### Out of Memory (OOM)

**Problem**: "CUDA out of memory" errors

**Solutions**:
1. Use smaller models (Whisper: `tiny` or `base`)
2. Reduce batch sizes
3. Close other GPU applications
4. Set `HF_DEVICE=cpu` for HuggingFace if needed

### Performance Not Improved

**Problem**: GPU enabled but no speedup

**Solutions**:
1. Verify GPU is being used: Check logs for "cuda" device
2. Ensure models are loaded on GPU
3. Check GPU utilization: `nvidia-smi` during processing
4. Use larger models (GPU benefits more with larger models)

## Model Recommendations for RTX 3050

### Whisper Models
- **tiny**: Fastest, ~39M params, ~150MB VRAM
- **base**: Good balance, ~74M params, ~290MB VRAM ✅ Recommended
- **small**: Better accuracy, ~244M params, ~1GB VRAM
- **medium**: High accuracy, ~769M params, ~3GB VRAM (may be slow)

### Chatbot Models
- **HuggingFace**: Use `HF_DEVICE=cuda` for GPU acceleration
- **llama.cpp**: CPU-only (no GPU support), but very fast on CPU

## Monitoring GPU Usage

```bash
# Watch GPU usage in real-time
nvidia-smi -l 1
```

## Notes

- **llama.cpp** doesn't support GPU directly. For GPU-accelerated LLM, use HuggingFace models.
- GPU memory is shared between Whisper, diarization, and chatbot models.
- RTX 3050 has 8GB VRAM - sufficient for base models, but may struggle with large models.

