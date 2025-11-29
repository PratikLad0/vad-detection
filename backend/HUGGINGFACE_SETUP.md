# Hugging Face Setup Guide

This guide explains how to set up and use Hugging Face models as a chatbot backend.

## Requirements

### Software Requirements

1. **Python 3.9+** (already required for backend)
2. **transformers library** (included in `requirements.txt`)
3. **torch (PyTorch)** (included in `requirements.txt`)
4. **Internet connection** (for downloading models on first use)

### Hardware Requirements

#### CPU Mode (Default)
- **RAM**: Minimum 4GB, 8GB+ recommended
  - Small models (<1GB): 4GB RAM
  - Medium models (1-2GB): 8GB RAM
  - Large models (>2GB): 16GB+ RAM
- **Storage**: 2-5GB free space (for model files)
- **CPU**: Multi-core recommended for better performance

#### GPU Mode (Optional, Faster)
- **NVIDIA GPU** with CUDA support
- **CUDA Toolkit**: Version 11.8 or 12.1+
- **cuDNN**: Compatible with CUDA version
- **GPU Drivers**: Latest compatible with CUDA
- **VRAM**: 
  - Small models: 2GB+ VRAM
  - Medium models: 4GB+ VRAM
  - Large models: 8GB+ VRAM

## Installation

### 1. Install Dependencies

The required packages are already in `requirements.txt`:
```bash
pip install transformers torch
```

### 2. Verify Installation

```python
python -c "import transformers; import torch; print(f'Transformers: {transformers.__version__}'); print(f'PyTorch: {torch.__version__}')"
```

### 3. Check GPU Availability (Optional)

```python
python -c "import torch; print(f'CUDA available: {torch.cuda.is_available()}'); print(f'CUDA device: {torch.cuda.get_device_name(0) if torch.cuda.is_available() else \"N/A\"}')"
```

## Configuration

### Environment Variables

In your `.env` file:

```env
# Set Hugging Face as primary backend (optional)
CHATBOT_BACKEND=huggingface

# Model selection
HF_MODEL_NAME=microsoft/DialoGPT-medium

# Device selection
HF_DEVICE=cpu  # or "cuda" if you have GPU
```

### Recommended Models

#### For CPU (Smaller, Faster)
- `microsoft/DialoGPT-medium` (~350MB, good quality)
- `gpt2` (~500MB, fast)
- `microsoft/phi-2` (~2GB, better quality)

#### For GPU (Larger, Better Quality)
- `microsoft/DialoGPT-large` (~800MB)
- `facebook/blenderbot-400M-distill` (~1.5GB)
- `microsoft/DialoGPT-small` (~350MB, fastest)

## First Run

On first use, the model will download automatically:
- Models are cached in `~/.cache/huggingface/` (Linux/Mac) or `C:\Users\<user>\.cache\huggingface\` (Windows)
- Download size: 350MB - 1.5GB depending on model
- Subsequent runs use cached model (no download needed)

## GPU Setup (Optional)

### Windows

1. **Check GPU Compatibility**
   ```bash
   nvidia-smi
   ```

2. **Install CUDA Toolkit**
   - Download from: https://developer.nvidia.com/cuda-downloads
   - Install CUDA 11.8 or 12.1+
   - Ensure GPU drivers are up to date

3. **Install PyTorch with CUDA**
   ```bash
   pip install torch torchvision torchaudio --index-url https://download.pytorch.org/whl/cu118
   ```

4. **Verify CUDA**
   ```python
   import torch
   print(torch.cuda.is_available())  # Should print True
   ```

5. **Update .env**
   ```env
   HF_DEVICE=cuda
   ```

### Linux

1. **Install NVIDIA Drivers**
   ```bash
   sudo apt-get update
   sudo apt-get install nvidia-driver-<version>
   ```

2. **Install CUDA Toolkit**
   ```bash
   # Follow NVIDIA's installation guide for your distribution
   # https://developer.nvidia.com/cuda-downloads
   ```

3. **Install PyTorch with CUDA**
   ```bash
   pip install torch torchvision torchaudio --index-url https://download.pytorch.org/whl/cu118
   ```

4. **Update .env**
   ```env
   HF_DEVICE=cuda
   ```

### macOS

- **Note**: macOS doesn't support CUDA. Use CPU mode or Apple Silicon (M1/M2) with MPS backend (requires additional setup)

## Troubleshooting

### Model Download Fails

**Problem**: Model fails to download
**Solutions**:
- Check internet connection
- Verify disk space (need 2-5GB free)
- Check write permissions to cache directory
- Try a different model (smaller size)

### Out of Memory (OOM) Errors

**Problem**: "CUDA out of memory" or system runs out of RAM
**Solutions**:
- Use a smaller model (e.g., `gpt2` instead of `DialoGPT-large`)
- Set `HF_DEVICE=cpu` if using GPU
- Close other applications to free RAM
- Reduce `LLAMA_N_CTX` if using llama.cpp

### Slow Performance

**Problem**: Responses are very slow
**Solutions**:
- Use GPU if available (`HF_DEVICE=cuda`)
- Use a smaller model
- Increase `LLAMA_N_THREADS` for CPU (if using llama.cpp)
- Consider using OpenAI as primary backend

### CUDA Not Available

**Problem**: `torch.cuda.is_available()` returns False
**Solutions**:
- Verify GPU drivers are installed: `nvidia-smi`
- Check CUDA installation: `nvcc --version`
- Reinstall PyTorch with CUDA support
- Ensure CUDA version matches PyTorch CUDA version

## Performance Comparison

| Model | Size | RAM (CPU) | VRAM (GPU) | Speed (CPU) | Speed (GPU) |
|-------|------|-----------|------------|-------------|-------------|
| DialoGPT-small | 350MB | 2GB | 1GB | Slow | Fast |
| DialoGPT-medium | 350MB | 4GB | 2GB | Medium | Very Fast |
| DialoGPT-large | 800MB | 8GB | 4GB | Slow | Fast |
| GPT-2 | 500MB | 4GB | 2GB | Medium | Fast |
| phi-2 | 2GB | 8GB | 4GB | Slow | Fast |

## Model Recommendations

### For Development/Testing
- **Best**: `microsoft/DialoGPT-medium` (good balance)
- **Fastest**: `gpt2` (quick responses)

### For Production (CPU)
- **Best**: `microsoft/DialoGPT-medium` (quality/speed balance)
- **Alternative**: `microsoft/phi-2` (better quality, slower)

### For Production (GPU)
- **Best**: `microsoft/DialoGPT-large` (best quality)
- **Fast**: `microsoft/DialoGPT-medium` (good speed)

## Additional Resources

- **Hugging Face Models**: https://huggingface.co/models
- **Transformers Documentation**: https://huggingface.co/docs/transformers
- **PyTorch Installation**: https://pytorch.org/get-started/locally/
- **CUDA Installation**: https://developer.nvidia.com/cuda-downloads

