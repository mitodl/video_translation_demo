# MIT Video Translation Viewer

A GitHub Pages application for viewing MIT course videos with multi-language subtitle support.

## Features

- Video playback using YouTube IFrame API
- **Custom subtitle overlays** synced with video playback
- Multiple translation methods:
  - **GPT-4o-mini** - Fast, efficient translations
  - **DeepL** - High-quality neural translations
  - **GPT-5** - Latest model translations
  - **DeepL + GPT-5 Hybrid** - DeepL translation refined by GPT-5
- Multi-language subtitle support (up to 9 languages)
- Real-time subtitle synchronization (100ms precision)
- Clean, responsive interface
- Full subtitle transcript display below video

## Project Structure

```
mbertrand.github.io/
├── index.html              # Main page
├── app.js                  # Application logic
├── translation/
│   ├── manifest.json       # Video and translation metadata
│   └── videos/
│       ├── [video-id]/
│       │   ├── youtube_id.txt           # YouTube video ID
│       │   ├── [video-id]-en.srt        # Original English subtitles
│       │   ├── gpt-4o-mini/
│       │   │   └── [video-id]-en_output-[lang].srt
│       │   ├── deep-l/
│       │   │   └── [video-id]-en_output-[lang].srt
│       │   └── gpt-5/
│       │       └── [video-id]-en_output-[lang].srt
│       └── ...
```

## Adding New Videos

1. Create a new folder under `translation/videos/` with the video ID as the folder name
2. Add a `youtube_id.txt` file containing the YouTube video ID
3. Add the English subtitle file: `[video-id]-en.srt`
4. Create subfolders for each translation method: `gpt-4o-mini/`, `deep-l/`, `gpt-5/`
5. Update `translation/manifest.json`:

```json
{
  "videos": [
    {
      "id": "your-video-id",
      "title": "Your Video Title",
      "youtubeId": "YouTube_Video_ID",
      "methods": ["gpt-4o-mini", "deep-l", "gpt-5", "deep-l_gpt5"],
      "languages": {
        "gpt-4o-mini": ["en", "ar", "de", "es", "fr", "hi", "kr", "pt", "zh"],
        "deep-l": ["en", "ar", "de", "es", "fr", "pt", "zh"],
        "gpt-5": ["en", "ar", "de", "es", "fr", "hi", "kr", "pt", "zh"],
        "deep-l_gpt5": ["en", "ar", "de", "es", "fr", "pt", "zh"]
      }
    }
  ]
}
```

## Adding New Translations

1. Place translated SRT files in the appropriate method folder with the correct naming convention:
   - **gpt-4o-mini**: `[video-id]-en_output-[lang-code].srt`
   - **deep-l**: `[video-id]-output-deepl-[lang-code].srt`
   - **gpt-5**: `[video-id]-output-gpt-5-[lang-code].srt`
   - **deep-l_gpt5**: `[video-id]-output-deepl-gpt-5-[lang-code].srt`

2. Update the `languages` object in `manifest.json` for the specific method

## Supported Languages

- `en` - English
- `ar` - Arabic
- `de` - German
- `es` - Spanish
- `fr` - French
- `hi` - Hindi
- `kr` - Korean
- `pt` - Portuguese
- `zh` - Chinese

## Local Development

Since this is a static site, you can test locally using any HTTP server:

```bash
# Python 3
python -m http.server 8000

# Node.js
npx http-server

# PHP
php -S localhost:8000
```

Then visit `http://localhost:8000`

## Deployment

The site is automatically deployed via GitHub Pages from the main branch.
Access it at: `https://mbertrand.github.io/`

## Technologies Used

- [YouTube IFrame API](https://developers.google.com/youtube/iframe_api_reference) - Official YouTube player integration
- Custom subtitle sync engine - Parses SRT files and syncs with video playback
- Vanilla JavaScript - No frameworks or build tools required
- GitHub Pages - Static site hosting

## How Subtitle Overlays Work

The application uses a custom subtitle synchronization system:

1. **SRT Parsing**: Subtitle files are parsed to extract timing and text data
2. **Time Synchronization**: The YouTube player's current time is polled every 100ms
3. **Overlay Display**: Matching subtitles are displayed as overlays on the video
4. **Auto Hide/Show**: Subtitles automatically appear and disappear based on timing
5. **Full Transcript**: A complete scrollable transcript is shown below the video
