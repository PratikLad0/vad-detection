# CPU Setup Guide

Complete guide for setting up the backend to run on CPU (no GPU required).

## Prerequisites

### Hardware Requirements
- **CPU**: Multi-core processor recommended (4+ cores for better performance)
- **RAM**: 
  - Minimum 4GB
  - 8GB+ recommended
  - 16GB+ for larger models
- **Storage**: 5-10GB free space (for models and dependencies)

### Software Requirements
- **Python** 3.9+
- **pip** package manager
- **FFmpeg** (required for Whisper audio processing)

## Step 1: Install FFmpeg

### Windows

1. Download FFmpeg from: https://www.gyan.dev/ffmpeg/builds/
2. Extract the zip file to a location (e.g., `C:\ffmpeg`)
3. Add FFmpeg to your system PATH:
   - Open System Properties → Environment Variables
   - Edit the "Path" variable
   - Add the path to the `bin` folder (e.g., `C:\ffmpeg\bin`)
4. Verify installation:
   ```powershell
   ffmpeg -version
   ```

### Linux

```bash
sudo apt-get update
sudo apt-get install ffmpeg
```

### macOS

```bash
brew install ffmpeg
```

## Step 2: Create Virtual Environment

```bash
# Windows PowerShell:
python -m venv .venv
.venv\Scripts\Activate.ps1

# Windows CMD:
python -m venv .venv
.venv\Scripts\activate.bat

# Linux/Mac:
python3 -m venv .venv
source .venv/bin/activate
```

## Step 3: Install Dependencies

```bash
# Install all requirements (CPU-only PyTorch)
pip install -r requirements.txt
```

**Note**: `requirements.txt` includes CPU-only PyTorch by default. This is perfect for CPU setup.

## Step 4: Verify Installation

```python
python -c "import torch; print(f'PyTorch version: {torch.__version__}'); print(f'CUDA available: {torch.cuda.is_available()}')"
```

Expected output:
```
PyTorch version: 2.1.0
CUDA available: False
```

This is correct for CPU-only setup.

## Step 5: Configure Backend

Create or update your `.env` file:

```env
# Use CPU (default)
USE_GPU=false

# HuggingFace on CPU
HF_DEVICE=cpu

# Whisper model (use smaller models for CPU)
WHISPER_MODEL=tiny
```

### Model Recommendations for CPU

#### Whisper Models (Transcription)
- **tiny**: Fastest, ~39M params, ~150MB RAM ✅ Recommended for CPU
- **base**: Good balance, ~74M params, ~290MB RAM (slower)
- **small**: Better accuracy, ~244M params, ~1GB RAM (slow on CPU)

#### Chatbot Models
- **llama.cpp**: Very fast on CPU, recommended ✅
- **HuggingFace**: Works on CPU but slower than llama.cpp

## Step 6: Start Backend

```bash
cd backend
uvicorn main:app --reload
```

When prompted, choose **option 2 (CPU)** or it will auto-detect if `USE_GPU=false` is set.

## Performance Expectations

CPU performance varies based on your hardware:

| Component | Typical Time (4-core CPU) | Typical Time (8-core CPU) |
|-----------|---------------------------|---------------------------|
| Whisper (tiny) | ~1-2s | ~0.5-1s |
| Whisper (base) | ~2-3s | ~1-2s |
| Speaker Diarization | ~1-2s | ~0.5-1s |
| llama.cpp Chatbot | ~0.5-1s | ~0.3-0.5s |
| HuggingFace Chatbot | ~2-5s | ~1-3s |

## Optimization Tips

### 1. Use Smaller Models
- Whisper: Use `tiny` instead of `base` or `small`
- Chatbot: Prefer `llama.cpp` over HuggingFace for CPU

### 2. Optimize Thread Count
The backend automatically detects optimal thread count:
- Uses 75% of CPU cores
- Minimum 2 threads
- Maximum 8 threads

### 3. Close Other Applications
Free up CPU and RAM for better performance:
- Close unnecessary applications
- Close browser tabs
- Stop other background processes

### 4. Use Quantized Models
- llama.cpp models are already quantized (Q4_K_M)
- Quantized models use less RAM and run faster

## Troubleshooting

### Slow Performance

**Problem**: Processing is very slow

**Solutions**:
1. Use smaller models (`tiny` for Whisper)
2. Use `llama.cpp` instead of HuggingFace for chatbot
3. Close other applications to free CPU/RAM
4. Check CPU usage: Task Manager (Windows) or `top` (Linux)
5. Ensure multi-threading is enabled

### Out of Memory

**Problem**: System runs out of RAM

**Solutions**:
1. Use smaller models (`tiny` for Whisper)
2. Close other applications
3. Reduce `LLAMA_N_CTX` if using llama.cpp
4. Set `HF_DEVICE=cpu` explicitly
5. Consider upgrading RAM

### FFmpeg Not Found

**Problem**: `ffmpeg: command not found`

**Solutions**:
1. Verify FFmpeg installation: `ffmpeg -version`
2. Add FFmpeg to PATH (see Step 1)
3. Restart terminal after adding to PATH
4. On Windows, restart computer if needed

### Model Download Fails

**Problem**: Models fail to download on first use

**Solutions**:
1. Check internet connection
2. Verify disk space (need 2-5GB free)
3. Check write permissions to cache directory
4. Try a different model (smaller size)
5. Models cache in `~/.cache/huggingface/` (Linux/Mac) or `C:\Users\<user>\.cache\huggingface\` (Windows)

### Import Errors

**Problem**: Module not found errors

**Solutions**:
1. Ensure virtual environment is activated
2. Reinstall requirements: `pip install -r requirements.txt`
3. Check Python version: `python --version` (should be 3.9+)
4. Try upgrading pip: `pip install --upgrade pip`

## Performance Comparison: CPU vs GPU

| Task | CPU (4-core) | CPU (8-core) | GPU (RTX 3050) |
|------|-------------|--------------|----------------|
| Whisper (tiny) | ~1-2s | ~0.5-1s | ~0.3-0.5s |
| Whisper (base) | ~2-3s | ~1-2s | ~0.5-1s |
| Diarization | ~1-2s | ~0.5-1s | ~0.3-0.5s |
| llama.cpp | ~0.5-1s | ~0.3-0.5s | N/A (CPU-only) |
| HuggingFace | ~2-5s | ~1-3s | ~0.2-0.5s |

**Note**: GPU provides 2-4x speedup for most tasks, but CPU is perfectly usable for development and smaller workloads.

## When to Use CPU vs GPU

### Use CPU If:
- ✅ No NVIDIA GPU available
- ✅ Development and testing
- ✅ Small workloads
- ✅ Cost optimization
- ✅ Cloud instances without GPU

### Use GPU If:
- ✅ NVIDIA GPU available
- ✅ Production workloads
- ✅ Large batch processing
- ✅ Real-time requirements
- ✅ Multiple concurrent users

## Additional Resources

- [GPU Setup Guide](GPU_SETUP.md) - If you have an NVIDIA GPU
- [Hugging Face Setup](HUGGINGFACE_SETUP.md) - For HuggingFace model configuration
- [Performance Optimizations](PERFORMANCE_OPTIMIZATIONS.md) - Performance tuning tips

## Notes

- CPU setup is simpler and doesn't require CUDA installation
- All models work on CPU, just slower than GPU
- llama.cpp is optimized for CPU and provides excellent performance
- For best CPU performance, use quantized models and smaller Whisper models

