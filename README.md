# MIT Video Translation Viewer

A GitHub Pages application for viewing MIT course videos with multi-language subtitle support.

## Features

- Video playback using YouTube iframe embed
- Multiple translation methods (GPT-4o-mini, DeepL, GPT-5)
- Multi-language subtitle support
- Clean, responsive interface
- Full subtitle display with timestamps

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
      "methods": ["gpt-4o-mini", "deep-l", "gpt-5"],
      "languages": {
        "gpt-4o-mini": ["en", "ar", "de", "es", "fr", "hi", "kr", "pt", "zh"],
        "deep-l": [],
        "gpt-5": []
      }
    }
  ]
}
```

## Adding New Translations

1. Place translated SRT files in the appropriate method folder:
   - Format: `[video-id]-en_output-[lang-code].srt`
   - Example: `L2.1.HAIM_Holistic_AI_for_Medicine-en_output-zh.srt`

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

- YouTube IFrame API - Video embedding and playback
- Vanilla JavaScript - No frameworks required
- GitHub Pages - Static site hosting
