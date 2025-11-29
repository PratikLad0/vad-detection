# CUDA 12.4 Setup Guide

## ✅ CUDA 12.4 Support

**Yes, the backend supports CUDA 12.4!** Your NVIDIA RTX 3050 is fully compatible with CUDA 12.4.

## Requirements

1. **NVIDIA Driver**: Version 550+ (required for CUDA 12.4)
   - Check your driver: `nvidia-smi`
   - Update if needed: Download from [NVIDIA Drivers](https://www.nvidia.com/Download/index.aspx)

2. **CUDA Toolkit 12.4**: Download from [NVIDIA CUDA Toolkit](https://developer.nvidia.com/cuda-downloads)

3. **PyTorch with CUDA 12.4**: Install using the command below

## Installation Steps

### Step 1: Verify CUDA 12.4 Installation

```bash
# Check CUDA version
nvcc --version

# Check GPU and driver
nvidia-smi
```

Expected output should show CUDA 12.4 and driver 550+.

### Step 2: Install PyTorch with CUDA 12.4

```bash
# Uninstall current PyTorch (if installed)
pip uninstall torch torchvision torchaudio

# Install PyTorch with CUDA 12.4 support
# Note: PyTorch uses cu121 wheels which are backward compatible with CUDA 12.4
pip install torch torchvision torchaudio --index-url https://download.pytorch.org/whl/cu121
```

**Important**: PyTorch doesn't have a separate `cu124` index. CUDA 12.1 wheels (`cu121`) are fully backward compatible with CUDA 12.4, so use the `cu121` index.

### Step 3: Verify Installation

```python
python -c "import torch; print(f'CUDA available: {torch.cuda.is_available()}'); print(f'CUDA version: {torch.version.cuda if torch.cuda.is_available() else \"N/A\"}'); print(f'GPU: {torch.cuda.get_device_name(0) if torch.cuda.is_available() else \"N/A\"}')"
```

Expected output:
```
CUDA available: True
CUDA version: 12.4
GPU: NVIDIA GeForce RTX 3050
```

### Step 4: Configure Backend

Update your `.env` file:
```env
USE_GPU=true
HF_DEVICE=cuda
WHISPER_MODEL=base  # Can use larger models with CUDA 12.4
```

### Step 5: Start Backend

```bash
uvicorn main:app --reload
```

When prompted, choose option 1 (GPU/CUDA) or set `USE_GPU=true` in `.env` to skip the prompt.

## Compatibility Notes

- **RTX 3050**: ✅ Fully compatible with CUDA 12.4
- **PyTorch**: Latest versions support CUDA 12.4
- **Whisper**: Works with CUDA 12.4
- **SpeechBrain**: Works with CUDA 12.4
- **Transformers (HuggingFace)**: Works with CUDA 12.4

## Troubleshooting

### Issue: PyTorch doesn't find CUDA 12.4

**Solution**: PyTorch may use CUDA 12.1 wheels which are backward compatible:
```bash
pip install torch torchvision torchaudio --index-url https://download.pytorch.org/whl/cu121
```

CUDA 12.1 wheels work with CUDA 12.4 due to backward compatibility.

### Issue: Driver version too old

**Solution**: Update NVIDIA drivers to 550+:
- Windows: Download from NVIDIA website
- Linux: Use package manager or NVIDIA installer

### Issue: CUDA version mismatch

**Solution**: Ensure PyTorch CUDA version matches or is compatible:
- CUDA 12.4 works with PyTorch built for CUDA 12.1+ (backward compatible)
- Check: `torch.version.cuda` should show 12.1 or 12.4

## Performance Benefits

With CUDA 12.4 on RTX 3050:
- **Whisper**: 2-3x faster than CPU
- **Speaker Diarization**: 3-4x faster than CPU
- **HuggingFace Models**: 2-4x faster than CPU

## Additional Resources

- [NVIDIA CUDA 12.4 Release Notes](https://docs.nvidia.com/cuda/archive/12.4.0/cuda-toolkit-release-notes/)
- [PyTorch CUDA Installation](https://pytorch.org/get-started/locally/)
- [CUDA Compatibility Guide](https://docs.nvidia.com/deploy/cuda-compatibility/)

