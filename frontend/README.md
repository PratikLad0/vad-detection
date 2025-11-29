# Frontend - VAD WebRTC Recorder

React + TypeScript + Vite frontend for the VAD-based audio recorder with wake word detection and real-time transcription.

## Prerequisites

- **Node.js** 18+ and npm
- **Modern browser** with WebRTC support (Chrome, Firefox, Edge, Safari)

## Installation

```bash
npm install
```

## Development

Start the development server:

```bash
npm run dev
```

The app will be available at `http://localhost:5173`

## Build for Production

```bash
npm run build
```

The production build will be in the `dist/` directory.

## Preview Production Build

```bash
npm run preview
```

## Environment Variables

Create a `.env` file in the `frontend/` directory (see `.env.example` for template):

```env
VITE_API_URL=http://localhost:8000
VITE_APP_NAME=VAD WebRTC Recorder
VITE_ENVIRONMENT=development
```

### Required Variables

- `VITE_API_URL`: Backend API URL (default: `http://localhost:8000`)

### Optional Variables

- `VITE_APP_NAME`: Application name displayed in UI
- `VITE_ENVIRONMENT`: `development` or `production` (affects logging)

## Features

- **Wake Word Detection**: "Hey AI" or "start" triggers recording
- **Voice Activity Detection**: Automatic speech detection and recording
- **Real-time Transcription**: Live speech-to-text using Web Speech API
- **Text File Export**: Optional saving of transcriptions as .txt files
- **Modern UI**: Dark/gold theme with Tailwind CSS
- **Event Logging**: Detailed system event logs
- **Error Handling**: Comprehensive error boundaries and recovery

## Usage

1. **Grant Microphone Permission**: Browser will prompt on first use
2. **Start Listening**: Click "🎤 Start listening" button
3. **Trigger Recording**: Say "Hey AI" or "start"
4. **Speak**: System automatically detects speech and records
5. **Automatic Upload**: Recording uploads when speech ends
6. **Text File Saving**: Enable toggle to save transcriptions as .txt files

## Project Structure

```
frontend/
├── src/
│   ├── App.tsx              # Main application component
│   ├── components/
│   │   └── ErrorBoundary.tsx # Error boundary component
│   ├── utils/
│   │   ├── api.ts           # API client with retry logic
│   │   └── logger.ts        # Logging utility
│   ├── config.ts            # Configuration
│   ├── index.css            # Global styles
│   └── main.tsx             # Entry point
├── public/                  # Static assets
├── .env.example            # Environment variables template
├── package.json
├── tailwind.config.js      # Tailwind CSS configuration
├── vite.config.ts          # Vite configuration
└── tsconfig.json           # TypeScript configuration
```

## Scripts

- `npm run dev`: Start development server
- `npm run build`: Build for production
- `npm run preview`: Preview production build
- `npm run lint`: Run ESLint

## Browser Compatibility

- ✅ Chrome/Edge 90+ (full support including speech recognition)
- ✅ Firefox 88+ (WebRTC support, no speech recognition)
- ✅ Safari 14+ (WebRTC support, limited speech recognition)

**Note**: Speech recognition (transcription) works best in Chrome/Edge browsers.

## Troubleshooting

### Microphone Not Working
- Check browser permissions (Settings > Privacy > Microphone)
- Ensure HTTPS in production (required for microphone access)
- Check browser console for errors

### Speech Recognition Not Working
- Use Chrome or Edge browser
- Check microphone permissions
- Verify browser supports Web Speech API

### API Connection Issues
- Verify backend is running on `VITE_API_URL`
- Check CORS configuration in backend
- Check browser console for network errors

### Build Errors
- Clear `node_modules` and reinstall: `rm -rf node_modules && npm install`
- Check Node.js version: `node --version` (should be 18+)
- Clear Vite cache: `rm -rf node_modules/.vite`

## Development Tips

- Use browser DevTools to inspect WebRTC streams
- Check Network tab for API requests
- Monitor Console for logs and errors
- Use React DevTools for component debugging
