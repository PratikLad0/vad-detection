"""
Chatbot Service with multiple LLM backends:
- llama.cpp (local, primary)
- OpenAI GPT (fallback)
- Hugging Face (fallback)
"""

import os
import logging
from typing import Optional, Dict, List
from pathlib import Path
import re
from dotenv import load_dotenv

# Load environment variables (in case this module is imported before main.py loads them)
load_dotenv()

logger = logging.getLogger(__name__)

# Get the directory where this script is located (backend directory)
BACKEND_DIR = Path(__file__).parent.resolve()

# Try to import llama-cpp-python
try:
    from llama_cpp import Llama
    LLAMA_AVAILABLE = True
except ImportError:
    LLAMA_AVAILABLE = False
    logger.warning("llama-cpp-python not available. Install with: pip install llama-cpp-python")

# Try to import OpenAI
try:
    import openai
    OPENAI_AVAILABLE = True
except ImportError:
    OPENAI_AVAILABLE = False
    logger.warning("openai not available. Install with: pip install openai")

# Global models (lazy loaded)
_llama_model: Optional[Llama] = None
_hf_model = None
_hf_tokenizer = None
HF_AVAILABLE = False
HF_CONFIGURED = False

# Configuration from environment
llama_model_path_raw = os.getenv("LLAMA_MODEL_PATH", "")
# Resolve model path: if relative, resolve relative to backend directory
if llama_model_path_raw:
    model_path = Path(llama_model_path_raw)
    if not model_path.is_absolute():
        # Resolve relative to backend directory
        LLAMA_MODEL_PATH = str((BACKEND_DIR / model_path).resolve())
    else:
        LLAMA_MODEL_PATH = str(model_path.resolve())
else:
    LLAMA_MODEL_PATH = ""

LLAMA_N_CTX = int(os.getenv("LLAMA_N_CTX", "2048"))
LLAMA_N_THREADS = int(os.getenv("LLAMA_N_THREADS", "4"))

OPENAI_API_KEY = os.getenv("OPENAI_API_KEY", "")
OPENAI_MODEL = os.getenv("OPENAI_MODEL", "gpt-3.5-turbo")

# Validate OpenAI API key (check if it's set and not a placeholder)
OPENAI_VALID_KEY = (
    OPENAI_AVAILABLE and 
    OPENAI_API_KEY and 
    OPENAI_API_KEY.strip() != "" and 
    OPENAI_API_KEY != "your_openai_api_key_here" and
    OPENAI_API_KEY.startswith("sk-")  # OpenAI API keys typically start with "sk-"
)

HF_MODEL_NAME = os.getenv("HF_MODEL_NAME", "")
# Check USE_GPU first (set by main.py prompt), then HF_DEVICE, then default to cpu
use_gpu = os.getenv("USE_GPU", "").lower() in ("true", "1", "yes", "cuda")
hf_device_env = os.getenv("HF_DEVICE", "").lower()
if use_gpu:
    HF_DEVICE = "cuda"
elif hf_device_env in ("cuda", "gpu"):
    HF_DEVICE = "cuda"
else:
    HF_DEVICE = "cpu"  # Default to CPU

# Check if Hugging Face is configured
_AutoTokenizer = None
_AutoModelForCausalLM = None
_torch = None

if HF_MODEL_NAME:
    HF_CONFIGURED = True
    # Only try to import if configured
    try:
        from transformers import pipeline, AutoTokenizer, AutoModelForCausalLM
        import torch
        _AutoTokenizer = AutoTokenizer
        _AutoModelForCausalLM = AutoModelForCausalLM
        _torch = torch
        HF_AVAILABLE = True
        logger.info(f"Hugging Face configured: {HF_MODEL_NAME} on {HF_DEVICE}")
    except ImportError:
        HF_AVAILABLE = False
        logger.warning("Hugging Face is configured but transformers library is not available. Install with: pip install transformers torch")
else:
    logger.info("Hugging Face not configured (HF_MODEL_NAME not set in .env)")

# Primary backend preference
CHATBOT_BACKEND = os.getenv("CHATBOT_BACKEND", "llama").lower()  # llama, openai, huggingface

# Log configuration on startup
logger.info(f"Chatbot backend configured: {CHATBOT_BACKEND}")
if LLAMA_MODEL_PATH:
    logger.info(f"LLAMA_MODEL_PATH: {LLAMA_MODEL_PATH}")
    if os.path.exists(LLAMA_MODEL_PATH):
        logger.info(f"✓ llama.cpp model file found ({os.path.getsize(LLAMA_MODEL_PATH) / (1024*1024):.2f} MB)")
    else:
        logger.warning(f"✗ llama.cpp model file NOT found at: {LLAMA_MODEL_PATH}")
else:
    logger.warning("LLAMA_MODEL_PATH is not set in .env file")

# Bad words list for guardrails (minimal default list)
# Load from file for production use
BAD_WORDS = [
    "fuck", "shit", "damn", "bitch", "asshole", "bastard",
]

def load_bad_words_from_file(filepath: str) -> List[str]:
    """Load bad words from a file (one per line)"""
    try:
        with open(filepath, 'r', encoding='utf-8') as f:
            return [line.strip().lower() for line in f if line.strip()]
    except FileNotFoundError:
        logger.warning(f"Bad words file not found: {filepath}")
        return []

# Load bad words from file if specified
BAD_WORDS_FILE = os.getenv("BAD_WORDS_FILE", "")
if BAD_WORDS_FILE:
    BAD_WORDS.extend(load_bad_words_from_file(BAD_WORDS_FILE))


def check_content_guardrails(text: str) -> tuple[bool, Optional[str]]:
    """
    Check if text contains inappropriate content.
    Returns: (is_safe, error_message)
    Optimized for speed - should complete in < 10ms.
    """
    # Early return for empty text
    if not text or not text.strip():
        return True, None
    
    text_lower = text.lower()
    
    # Optimized: Check for bad words using set lookup (faster than list iteration)
    # Check if any bad word is a substring (word boundary check would be slower)
    for bad_word in BAD_WORDS:
        if bad_word in text_lower:
            logger.warning(f"Content filtered: bad word detected")
            return False, "Your message contains inappropriate content. Please rephrase."
    
    # Optimized: Only check repetition if text is long enough to potentially spam
    if len(text) > 50:  # Skip spam check for short messages
        words = text.split()
        if len(words) > 10:  # Only check if there are enough words
            # Use Counter for faster counting (but avoid import overhead, use dict)
            word_counts = {}
            for word in words:
                word_lower = word.lower()
                count = word_counts.get(word_lower, 0) + 1
                word_counts[word_lower] = count
                # Early exit if we find excessive repetition
                if count > 10:
                    return False, "Your message appears to be spam. Please rephrase."
    
    return True, None


def get_llama_model() -> Optional[Llama]:
    """Lazy load llama.cpp model"""
    global _llama_model
    if not LLAMA_AVAILABLE:
        logger.warning("llama-cpp-python is not available. Install with: pip install llama-cpp-python")
        return None
    
    if not LLAMA_MODEL_PATH:
        logger.warning("LLAMA_MODEL_PATH is not set in .env file")
        return None
    
    # Check if model file exists
    if not os.path.exists(LLAMA_MODEL_PATH):
        logger.error(f"llama.cpp model file not found: {LLAMA_MODEL_PATH}")
        logger.error(f"Please check your .env file and ensure LLAMA_MODEL_PATH points to a valid .gguf file")
        logger.error(f"Current backend directory: {BACKEND_DIR}")
        logger.error(f"Expected model path: {LLAMA_MODEL_PATH}")
        return None
    
    if _llama_model is None:
        try:
            logger.info(f"Loading llama.cpp model from: {LLAMA_MODEL_PATH}")
            logger.info(f"Model file size: {os.path.getsize(LLAMA_MODEL_PATH) / (1024*1024):.2f} MB")
            _llama_model = Llama(
                model_path=LLAMA_MODEL_PATH,
                n_ctx=LLAMA_N_CTX,
                n_threads=LLAMA_N_THREADS,
                verbose=False
            )
            logger.info("llama.cpp model loaded successfully")
        except Exception as e:
            logger.error(f"Failed to load llama.cpp model: {str(e)}")
            logger.error(f"Model path attempted: {LLAMA_MODEL_PATH}")
            return None
    return _llama_model


def get_hf_model():
    """Lazy load Hugging Face model"""
    global _hf_model, _hf_tokenizer
    if not HF_CONFIGURED:
        logger.debug("Hugging Face not configured, skipping model load")
        return None, None
    
    if not HF_AVAILABLE or _AutoTokenizer is None or _AutoModelForCausalLM is None:
        logger.warning("Hugging Face is configured but transformers library is not available")
        return None, None
    
    if _hf_model is None and HF_MODEL_NAME:
        try:
            logger.info(f"Loading Hugging Face model: {HF_MODEL_NAME}")
            _hf_tokenizer = _AutoTokenizer.from_pretrained(HF_MODEL_NAME)
            _hf_model = _AutoModelForCausalLM.from_pretrained(HF_MODEL_NAME)
            _hf_model.to(HF_DEVICE)
            _hf_model.eval()
            logger.info("Hugging Face model loaded successfully")
        except Exception as e:
            logger.error(f"Failed to load Hugging Face model: {str(e)}")
            return None, None
    return _hf_model, _hf_tokenizer


def generate_response_llama(prompt: str, max_tokens: int = 150) -> Optional[str]:
    """Generate response using llama.cpp - optimized for speed"""
    logger.info(f"llama.cpp: Processing transcription: '{prompt[:100]}{'...' if len(prompt) > 100 else ''}'")
    model = get_llama_model()
    if not model:
        return None
    
    try:
        # Format prompt for chat
        formatted_prompt = f"User: {prompt}\nAssistant:"
        
        # Optimized parameters for faster response
        response = model(
            formatted_prompt,
            max_tokens=max_tokens,
            temperature=0.7,
            top_p=0.9,
            repeat_penalty=1.1,
            stop=["User:", "\n\n"],
            # Performance optimizations
            n_threads=LLAMA_N_THREADS,  # Use configured thread count
            n_batch=512,  # Process in batches for better performance
        )
        
        text = response['choices'][0]['text'].strip()
        return text
    except Exception as e:
        logger.error(f"llama.cpp generation error: {str(e)}")
        return None


def generate_response_openai(prompt: str, max_tokens: int = 150) -> Optional[str]:
    """Generate response using OpenAI"""
    logger.info(f"OpenAI: Processing transcription: '{prompt[:100]}{'...' if len(prompt) > 100 else ''}'")
    if not OPENAI_VALID_KEY:
        return None
    
    try:
        # Use OpenAI client (new API format)
        client = openai.OpenAI(api_key=OPENAI_API_KEY)
        response = client.chat.completions.create(
            model=OPENAI_MODEL,
            messages=[
                {"role": "system", "content": "You are a helpful assistant. Keep responses concise and conversational."},
                {"role": "user", "content": prompt}
            ],
            max_tokens=max_tokens,
            temperature=0.7
        )
        return response.choices[0].message.content.strip()
    except Exception as e:
        logger.error(f"OpenAI generation error: {str(e)}")
        return None


def generate_response_huggingface(prompt: str, max_length: int = 150) -> Optional[str]:
    """Generate response using Hugging Face - optimized for speed"""
    logger.info(f"Hugging Face: Processing transcription: '{prompt[:100]}{'...' if len(prompt) > 100 else ''}'")
    if not HF_AVAILABLE or _torch is None:
        return None
    
    model, tokenizer = get_hf_model()
    if not model or not tokenizer:
        return None
    
    try:
        # Format input
        input_text = f"User: {prompt}\nAssistant:"
        inputs = tokenizer.encode(input_text, return_tensors="pt", truncation=True, max_length=512)
        inputs = inputs.to(HF_DEVICE)
        
        # Generate with optimized parameters for speed
        with _torch.no_grad():
            outputs = model.generate(
                inputs,
                max_length=inputs.shape[1] + max_length,
                temperature=0.7,
                do_sample=True,
                pad_token_id=tokenizer.eos_token_id,
                # Performance optimizations
                num_beams=1,  # Use greedy decoding (faster than beam search)
                early_stopping=False,  # Disable early stopping for speed
                use_cache=True,  # Enable KV cache for faster generation
            )
        
        # Decode response
        response = tokenizer.decode(outputs[0], skip_special_tokens=True)
        # Extract only the assistant part
        if "Assistant:" in response:
            response = response.split("Assistant:")[-1].strip()
        
        return response
    except Exception as e:
        logger.error(f"Hugging Face generation error: {str(e)}")
        return None


def initialize_chatbot_backends() -> Dict[str, bool]:
    """
    Initialize all chatbot backends at startup.
    Pre-loads models to avoid delays on first request.
    
    Returns:
        Dict with status of each backend: {"llama": bool, "openai": bool, "huggingface": bool}
    """
    logger.info("=" * 60)
    logger.info("Initializing Chatbot Backends...")
    logger.info("=" * 60)
    
    status = {
        "llama": False,
        "openai": False,
        "huggingface": False
    }
    
    # Initialize llama.cpp (always try if configured)
    logger.info("Checking llama.cpp backend...")
    try:
        model = get_llama_model()
        if model:
            status["llama"] = True
            logger.info("✓ llama.cpp backend ready")
        else:
            logger.warning("✗ llama.cpp backend not available (check LLAMA_MODEL_PATH in .env)")
    except Exception as e:
        logger.error(f"✗ llama.cpp backend error: {str(e)}")
    
    # Check OpenAI availability
    logger.info("Checking OpenAI backend...")
    if not OPENAI_AVAILABLE:
        logger.warning("✗ OpenAI backend not available (openai library not installed)")
    elif not OPENAI_VALID_KEY:
        if not OPENAI_API_KEY or OPENAI_API_KEY.strip() == "":
            logger.warning("✗ OpenAI backend not available (OPENAI_API_KEY not set in .env)")
        elif OPENAI_API_KEY == "your_openai_api_key_here":
            logger.warning("✗ OpenAI backend not available (OPENAI_API_KEY is placeholder - please set your actual key)")
        elif not OPENAI_API_KEY.startswith("sk-"):
            logger.warning("✗ OpenAI backend not available (OPENAI_API_KEY format invalid - should start with 'sk-')")
        else:
            logger.warning("✗ OpenAI backend not available (OPENAI_API_KEY invalid)")
    else:
        # Valid key found - test connection
        try:
            # Quick validation: try to create a client (doesn't make actual API call)
            client = openai.OpenAI(api_key=OPENAI_API_KEY)
            status["openai"] = True
            logger.info(f"✓ OpenAI backend ready (model: {OPENAI_MODEL})")
        except Exception as e:
            logger.warning(f"✗ OpenAI backend validation failed: {str(e)}")
    
    # Initialize Hugging Face (if configured)
    if HF_CONFIGURED:
        logger.info("Checking Hugging Face backend...")
        try:
            model, tokenizer = get_hf_model()
            if model and tokenizer:
                status["huggingface"] = True
                logger.info("✓ Hugging Face backend ready")
            else:
                logger.warning("✗ Hugging Face backend failed to initialize")
        except Exception as e:
            logger.error(f"✗ Hugging Face backend error: {str(e)}")
    else:
        logger.info("ℹ Hugging Face not configured (HF_MODEL_NAME not set in .env)")
    
    # Summary
    logger.info("=" * 60)
    logger.info("Chatbot Backend Status:")
    logger.info(f"  Primary Backend: {CHATBOT_BACKEND}")
    logger.info(f"  llama.cpp: {'✓ Ready' if status['llama'] else '✗ Not available'}")
    logger.info(f"  OpenAI: {'✓ Ready' if status['openai'] else '✗ Not available'}")
    logger.info(f"  Hugging Face: {'✓ Ready' if status['huggingface'] else '✗ Not available'}")
    
    # Check if at least one backend is ready
    any_ready = any(status.values())
    if any_ready:
        logger.info("=" * 60)
        logger.info("✓ CHATBOT READY - Backend(s) initialized successfully")
        logger.info("=" * 60)
    else:
        logger.warning("=" * 60)
        logger.warning("✗ CHATBOT NOT READY - No backends available")
        logger.warning("Please check your configuration in .env file")
        logger.warning("=" * 60)
    
    return status


def generate_chatbot_response(user_message: str) -> Dict[str, any]:
    """
    Generate chatbot response using available backends.
    Tries backends in order: configured backend -> fallbacks
    
    Args:
        user_message: The transcribed user question/input
    
    Returns:
        {
            "response": str or None,
            "backend_used": str,
            "error": str or None
        }
    """
    logger.info(f"Generating chatbot response for transcription: '{user_message[:100]}{'...' if len(user_message) > 100 else ''}'")
    
    # Check guardrails first
    is_safe, error_msg = check_content_guardrails(user_message)
    if not is_safe:
        return {
            "response": None,
            "backend_used": "guardrails",
            "error": error_msg
        }
    
    # Try backends in order of preference
    backends_to_try = []
    
    if CHATBOT_BACKEND == "llama":
        backends_to_try = ["llama"]
        if OPENAI_VALID_KEY:
            backends_to_try.append("openai")
        if HF_CONFIGURED:
            backends_to_try.append("huggingface")
    elif CHATBOT_BACKEND == "openai":
        if OPENAI_VALID_KEY:
            backends_to_try = ["openai", "llama"]
            if HF_CONFIGURED:
                backends_to_try.append("huggingface")
        else:
            logger.warning("OpenAI selected as backend but API key is invalid. Falling back to llama/huggingface.")
            backends_to_try = ["llama"]
            if HF_CONFIGURED:
                backends_to_try.append("huggingface")
    elif CHATBOT_BACKEND == "huggingface":
        if HF_CONFIGURED:
            backends_to_try = ["huggingface", "llama"]
            if OPENAI_VALID_KEY:
                backends_to_try.append("openai")
        else:
            logger.warning("Hugging Face selected as backend but not configured. Falling back to llama/openai.")
            backends_to_try = ["llama"]
            if OPENAI_VALID_KEY:
                backends_to_try.append("openai")
    else:
        backends_to_try = ["llama"]
        if OPENAI_VALID_KEY:
            backends_to_try.append("openai")
        if HF_CONFIGURED:
            backends_to_try.append("huggingface")
    
    for backend in backends_to_try:
        response = None
        
        if backend == "llama":
            response = generate_response_llama(user_message)
        elif backend == "openai":
            response = generate_response_openai(user_message)
        elif backend == "huggingface" and HF_CONFIGURED:
            response = generate_response_huggingface(user_message)
        
        if response:
            logger.info(f"Chatbot response generated using {backend}")
            return {
                "response": response,
                "backend_used": backend,
                "error": None
            }
    
    # All backends failed
    error_msg = "All chatbot backends are unavailable. Please check your configuration."
    logger.error(error_msg)
    return {
        "response": None,
        "backend_used": None,
        "error": error_msg
    }

