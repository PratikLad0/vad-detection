# GPU Setup Guide

Complete guide for setting up GPU acceleration with NVIDIA GPUs and CUDA.

## Prerequisites

### Hardware Requirements
- **NVIDIA GPU** with CUDA support
- **GPU Drivers**: Latest compatible version
- **VRAM**: 
  - Minimum 4GB for basic models
  - 8GB+ recommended for better performance
  - RTX 3050 (8GB) or better recommended

### Software Requirements
- **CUDA Toolkit**: Version 11.8, 12.1, 12.4, or 13.0
- **cuDNN**: Included with CUDA Toolkit
- **Python** 3.9+
- **pip** package manager

## CUDA Version Selection

### Recommended CUDA Versions

| CUDA Version | Driver Requirement | GPU Compatibility | PyTorch Support | Recommendation |
|--------------|-------------------|-------------------|-----------------|----------------|
| **12.4** | 550+ | All modern GPUs | ✅ Full (via cu121) | ⭐ **Best for RTX 3050/Ampere** |
| **12.1** | 525+ | All modern GPUs | ✅ Full | ✅ Good alternative |
| **11.8** | 450+ | All GPUs | ✅ Full | ✅ Most compatible |
| **13.0** | 580+ | All GPUs | ⚠️ Limited (use cu121) | ⚠️ Latest but may have issues |

### For RTX 3050 (Ampere Architecture)
- **Recommended**: CUDA 12.4 (best performance and compatibility)
- **Alternative**: CUDA 12.1 or 11.8 (if 12.4 has issues)
- **Not Recommended**: CUDA 13.0 (optimized for newer Blackwell GPUs)

## Step 1: Verify GPU and Drivers

```bash
# Check GPU and driver version
nvidia-smi
```

Expected output shows:
- GPU model (e.g., NVIDIA GeForce RTX 3050)
- Driver version (e.g., 550.xx or 581.xx)
- CUDA version supported by driver

## Step 2: Install CUDA Toolkit

### Windows Installation

1. **Download CUDA Toolkit**:
   - CUDA 12.4: https://developer.nvidia.com/cuda-12-4-0-download-archive
   - CUDA 12.1: https://developer.nvidia.com/cuda-12-1-0-download-archive
   - CUDA 11.8: https://developer.nvidia.com/cuda-11-8-0-download-archive
   - CUDA 13.0: https://developer.nvidia.com/cuda-downloads

2. **Before Installation**:
   - Close all applications (Chrome, VS Code, etc.)
   - Temporarily disable antivirus (Windows Defender)
   - Ensure 4-5GB free disk space on C: drive
   - Run installer as Administrator

3. **Installation Steps**:
   - Run installer as Administrator
   - Choose "Express" installation (recommended)
   - Wait for completion (10-15 minutes)
   - Restart computer if prompted

4. **Verify Installation**:
   ```powershell
   nvcc --version
   ```

   If `nvcc` not found, add to PATH:
   ```powershell
   # For CUDA 12.4
   [Environment]::SetEnvironmentVariable(
       "Path", 
       $env:Path + ";C:\Program Files\NVIDIA GPU Computing Toolkit\CUDA\v12.4\bin", 
       "User"
   )
   
   # Restart terminal after adding to PATH
   ```

### Linux Installation

```bash
# Ubuntu/Debian
wget https://developer.download.nvidia.com/compute/cuda/repos/ubuntu2204/x86_64/cuda-keyring_1.1-1_all.deb
sudo dpkg -i cuda-keyring_1.1-1_all.deb
sudo apt-get update
sudo apt-get -y install cuda-toolkit-12-4

# Add to PATH
echo 'export PATH=/usr/local/cuda-12.4/bin:$PATH' >> ~/.bashrc
echo 'export LD_LIBRARY_PATH=/usr/local/cuda-12.4/lib64:$LD_LIBRARY_PATH' >> ~/.bashrc
source ~/.bashrc

# Verify
nvcc --version
```

## Step 3: Install PyTorch with CUDA Support

**IMPORTANT**: Uninstall CPU-only PyTorch first, then install CUDA version.

```bash
# Uninstall current PyTorch
pip uninstall torch torchvision torchaudio -y

# Install PyTorch with CUDA support (choose based on your CUDA version):

# For CUDA 12.4 (RECOMMENDED - use cu121 wheels, backward compatible)
pip install torch torchvision torchaudio --index-url https://download.pytorch.org/whl/cu121

# For CUDA 12.1
pip install torch torchvision torchaudio --index-url https://download.pytorch.org/whl/cu121

# For CUDA 11.8
pip install torch torchvision torchaudio --index-url https://download.pytorch.org/whl/cu118

# For CUDA 13.0 (try cu130 first, fallback to cu121 if not available)
pip install torch torchvision torchaudio --index-url https://download.pytorch.org/whl/cu130
# OR if cu130 not available:
pip install torch torchvision torchaudio --index-url https://download.pytorch.org/whl/cu121
```

**Note**: PyTorch doesn't have separate `cu124` wheels. CUDA 12.1 wheels (`cu121`) are fully backward compatible with CUDA 12.4.

## Step 4: Verify CUDA Installation

```python
python -c "import torch; print('='*60); print('GPU Setup Verification'); print('='*60); print(f'CUDA available: {torch.cuda.is_available()}'); print(f'CUDA version: {torch.version.cuda if torch.cuda.is_available() else \"N/A\"}'); print(f'GPU: {torch.cuda.get_device_name(0) if torch.cuda.is_available() else \"N/A\"}'); print(f'GPU Memory: {torch.cuda.get_device_properties(0).total_memory / (1024**3):.1f} GB' if torch.cuda.is_available() else 'N/A'); print('='*60)"
```

Expected output:
```
============================================================
GPU Setup Verification
============================================================
CUDA available: True
CUDA version: 12.4  # or 12.1, 11.8, 13.0
GPU: NVIDIA GeForce RTX 3050
GPU Memory: 8.0 GB
============================================================
```

## Step 5: Install Other Dependencies

```bash
# Install remaining requirements
pip install -r requirements.txt
```

**Note**: `requirements-gpu.txt` is for reference only. After installing CUDA-enabled PyTorch, use `requirements.txt` for all other packages.

## Step 6: Configure Backend

Update your `.env` file:

```env
# Enable GPU
USE_GPU=true

# HuggingFace on GPU
HF_DEVICE=cuda

# Whisper model (can use larger with GPU)
WHISPER_MODEL=base
```

## Step 7: Start Backend

```bash
cd backend
uvicorn main:app --reload
```

When prompted, choose **option 1 (GPU/CUDA)** or it will auto-detect if `USE_GPU=true` is set.

## Performance Improvements

With GPU acceleration, you can expect:

| Component | CPU Time | GPU Time | Speedup |
|-----------|----------|----------|---------|
| Whisper (base) | ~2-3s | ~0.5-1s | 2-3x |
| Speaker Diarization | ~1-2s | ~0.3-0.5s | 3-4x |
| HuggingFace Chatbot | ~1-2s | ~0.2-0.5s | 2-4x |

## Model Recommendations for RTX 3050 (8GB VRAM)

### Whisper Models
- **tiny**: Fastest, ~39M params, ~150MB VRAM
- **base**: Good balance, ~74M params, ~290MB VRAM ✅ Recommended
- **small**: Better accuracy, ~244M params, ~1GB VRAM
- **medium**: High accuracy, ~769M params, ~3GB VRAM (may be slow)

### Chatbot Models
- **HuggingFace**: Use `HF_DEVICE=cuda` for GPU acceleration
- **llama.cpp**: CPU-only (no GPU support), but very fast on CPU

## Troubleshooting

### CUDA Installation Failed/Incomplete

**Problem**: CUDA installation didn't complete or `nvcc` not found

**Solutions**:
1. **Run installer as Administrator**: Right-click > Run as administrator
2. **Disable Antivirus**: Temporarily disable Windows Defender/antivirus
3. **Check Disk Space**: Ensure 4GB+ free space on C: drive
4. **Clean Previous Attempts**: Uninstall partial installations from Control Panel
5. **Check Installation Logs**: Look in `C:\Users\<YourUser>\AppData\Local\Temp\CUDA*.log`
6. **Try Different CUDA Version**: If 12.4 fails, try 12.1 or 11.8

### CUDA Not Available in PyTorch

**Problem**: `torch.cuda.is_available()` returns `False`

**Solutions**:
1. Verify GPU drivers: `nvidia-smi` (should show CUDA version)
2. Check CUDA installation: `nvcc --version` (if not found, add to PATH)
3. Reinstall PyTorch with CUDA support
4. Ensure CUDA version matches PyTorch CUDA version (or is compatible)
5. Add CUDA to PATH manually if needed
6. Restart terminal/PowerShell after installation

### Out of Memory (OOM) Errors

**Problem**: "CUDA out of memory" errors

**Solutions**:
1. Use smaller models (Whisper: `tiny` or `base`)
2. Reduce batch sizes
3. Close other GPU applications
4. Set `HF_DEVICE=cpu` for HuggingFace if needed
5. Monitor GPU memory: `nvidia-smi -l 1`

### Performance Not Improved

**Problem**: GPU enabled but no speedup

**Solutions**:
1. Verify GPU is being used: Check logs for "cuda" device
2. Ensure models are loaded on GPU
3. Check GPU utilization: `nvidia-smi` during processing
4. Use larger models (GPU benefits more with larger models)
5. Verify CUDA is actually being used: Check `torch.cuda.is_available()`

### Installation Hangs or Stops

**Problem**: CUDA installer hangs or stops

**Solutions**:
1. Close all applications (especially Chrome, VS Code)
2. Disable Windows Defender temporarily
3. Run installer in Safe Mode (if persistent issues)
4. Check Windows Event Viewer for errors
5. Try "Custom" installation (uncheck Visual Studio integration)
6. Ensure Visual C++ Redistributables are installed

## Monitoring GPU Usage

```bash
# Watch GPU usage in real-time
nvidia-smi -l 1

# Check GPU memory usage
nvidia-smi --query-gpu=memory.used,memory.total --format=csv
```

## Quick Installation Script (Windows)

Save as `install_pytorch_cuda.bat`:

```batch
@echo off
echo Installing PyTorch with CUDA support...
echo.

echo Step 1: Uninstalling old PyTorch...
pip uninstall torch torchvision torchaudio -y

echo.
echo Step 2: Installing PyTorch with CUDA 12.1 (compatible with 12.4)...
pip install torch torchvision torchaudio --index-url https://download.pytorch.org/whl/cu121

echo.
echo Step 3: Verifying installation...
python -c "import torch; print(f'CUDA available: {torch.cuda.is_available()}'); print(f'GPU: {torch.cuda.get_device_name(0) if torch.cuda.is_available() else \"N/A\"}')"

echo.
echo Installation complete!
pause
```

## Additional Resources

- [NVIDIA CUDA Downloads](https://developer.nvidia.com/cuda-downloads)
- [PyTorch CUDA Installation](https://pytorch.org/get-started/locally/)
- [CUDA Compatibility Guide](https://docs.nvidia.com/deploy/cuda-compatibility/)
- [Hugging Face GPU Setup](HUGGINGFACE_SETUP.md)

## Notes

- **llama.cpp** doesn't support GPU directly. For GPU-accelerated LLM, use HuggingFace models.
- GPU memory is shared between Whisper, diarization, and chatbot models.
- RTX 3050 has 8GB VRAM - sufficient for base models, but may struggle with large models.
- CUDA 12.1 PyTorch wheels work with CUDA 12.4 and 13.0 due to backward compatibility.
