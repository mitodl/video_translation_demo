// Application state
let manifest = null;
let currentSelection = {
    video: null,
    method: null,
    language: null
};

// DOM elements
const videoSelect = document.getElementById('video-select');
const methodSelect = document.getElementById('method-select');
const languageSelect = document.getElementById('language-select');
const subtitlesContent = document.getElementById('subtitles-content');
const subtitleCount = document.getElementById('subtitle-count');
const videoContainer = document.getElementById('video-container');

// Initialize the application
async function init() {
    try {
        // Load manifest
        const response = await fetch('translation/manifest.json');
        manifest = await response.json();

        // Populate video dropdown
        populateVideoSelect();

        // Set up event listeners
        setupEventListeners();

        // Set default selections
        setDefaults();
    } catch (error) {
        console.error('Failed to initialize app:', error);
        showError('Failed to load application data');
    }
}

// Set default selections
function setDefaults() {
    if (manifest.videos.length === 0) return;

    // Select first video
    currentSelection.video = 0;
    videoSelect.value = '0';

    const video = manifest.videos[0];
    loadVideo(video.youtubeId);

    // Populate and select gpt-4o-mini method
    populateMethodSelect(0);
    if (video.languages['gpt-4o-mini'] && video.languages['gpt-4o-mini'].length > 0) {
        currentSelection.method = 'gpt-4o-mini';
        methodSelect.value = 'gpt-4o-mini';

        // Populate and select Spanish language
        populateLanguageSelect(0, 'gpt-4o-mini');
        if (video.languages['gpt-4o-mini'].includes('es')) {
            currentSelection.language = 'es';
            languageSelect.value = 'es';

            // Load subtitles
            loadSubtitles();
        }
    }
}

// Populate video dropdown
function populateVideoSelect() {
    videoSelect.innerHTML = '<option value="">Select a video...</option>';

    manifest.videos.forEach((video, index) => {
        const option = document.createElement('option');
        option.value = index;
        option.textContent = video.title;
        videoSelect.appendChild(option);
    });
}

// Populate method dropdown
function populateMethodSelect(videoIndex) {
    methodSelect.innerHTML = '<option value="">Select a method...</option>';

    const video = manifest.videos[videoIndex];
    video.methods.forEach(method => {
        const option = document.createElement('option');
        option.value = method;
        option.textContent = method;

        // Disable if no languages available
        const hasLanguages = video.languages[method] && video.languages[method].length > 0;
        if (!hasLanguages) {
            option.disabled = true;
            option.textContent += ' (no translations yet)';
        }

        methodSelect.appendChild(option);
    });

    methodSelect.disabled = false;
}

// Populate language dropdown
function populateLanguageSelect(videoIndex, method) {
    languageSelect.innerHTML = '<option value="">Select a language...</option>';

    const video = manifest.videos[videoIndex];
    const languages = video.languages[method] || [];

    languages.forEach(langCode => {
        const option = document.createElement('option');
        option.value = langCode;
        option.textContent = manifest.languageNames[langCode] || langCode;
        languageSelect.appendChild(option);
    });

    languageSelect.disabled = false;
}

// Set up event listeners
function setupEventListeners() {
    videoSelect.addEventListener('change', (e) => {
        const videoIndex = e.target.value;

        if (videoIndex === '') {
            // Reset everything
            currentSelection.video = null;
            currentSelection.method = null;
            currentSelection.language = null;
            methodSelect.disabled = true;
            languageSelect.disabled = true;
            methodSelect.innerHTML = '<option value="">Select a method...</option>';
            languageSelect.innerHTML = '<option value="">Select a language...</option>';
            clearSubtitles();
            clearVideo();
        } else {
            currentSelection.video = parseInt(videoIndex);
            currentSelection.method = null;
            currentSelection.language = null;
            populateMethodSelect(videoIndex);
            languageSelect.disabled = true;
            languageSelect.innerHTML = '<option value="">Select a language...</option>';
            clearSubtitles();
            loadVideo(manifest.videos[videoIndex].youtubeId);
        }
    });

    methodSelect.addEventListener('change', (e) => {
        const method = e.target.value;

        if (method === '') {
            currentSelection.method = null;
            currentSelection.language = null;
            languageSelect.disabled = true;
            languageSelect.innerHTML = '<option value="">Select a language...</option>';
            clearSubtitles();
        } else {
            currentSelection.method = method;
            currentSelection.language = null;
            populateLanguageSelect(currentSelection.video, method);
            clearSubtitles();
        }
    });

    languageSelect.addEventListener('change', (e) => {
        const language = e.target.value;

        if (language === '') {
            currentSelection.language = null;
            clearSubtitles();
        } else {
            currentSelection.language = language;
            loadSubtitles();
        }
    });
}

// Load video using YouTube iframe
function loadVideo(youtubeId) {
    videoContainer.className = 'video-container';
    videoContainer.innerHTML = `
        <iframe
            src="https://www.youtube.com/embed/${youtubeId}?rel=0&modestbranding=1"
            allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture"
            allowfullscreen
        ></iframe>
    `;
}

// Clear video
function clearVideo() {
    videoContainer.className = 'video-container empty';
    videoContainer.innerHTML = `
        <div class="video-placeholder">
            <p>Select a video to start playback</p>
        </div>
    `;
}

// Load and display subtitles
async function loadSubtitles() {
    if (!currentSelection.video !== null && !currentSelection.method && !currentSelection.language) {
        return;
    }

    showLoading();

    try {
        const video = manifest.videos[currentSelection.video];
        const subtitlePath = getSubtitlePath(video, currentSelection.method, currentSelection.language);

        const response = await fetch(subtitlePath);
        if (!response.ok) {
            throw new Error(`Failed to load subtitles: ${response.status}`);
        }

        const srtContent = await response.text();
        const subtitles = parseSRT(srtContent);

        displaySubtitles(subtitles);
    } catch (error) {
        console.error('Error loading subtitles:', error);
        showError('Failed to load subtitles');
    }
}

// Get subtitle file path
function getSubtitlePath(video, method, language) {
    const videoId = video.id;

    // For English, use the original file
    if (language === 'en') {
        return `translation/videos/${videoId}/${videoId}-en.srt`;
    }

    // For other languages, use the translation
    return `translation/videos/${videoId}/${method}/${videoId}-en_output-${language}.srt`;
}

// Parse SRT format
function parseSRT(srt) {
    const subtitles = [];
    const blocks = srt.trim().split(/\n\s*\n/);

    blocks.forEach(block => {
        const lines = block.split('\n');
        if (lines.length >= 3) {
            const index = lines[0].trim();
            const timestamp = lines[1].trim();
            const text = lines.slice(2).join('\n').trim();

            subtitles.push({
                index,
                timestamp,
                text
            });
        }
    });

    return subtitles;
}

// Display subtitles
function displaySubtitles(subtitles) {
    if (subtitles.length === 0) {
        showEmptyState('No subtitles found');
        return;
    }

    subtitleCount.textContent = `${subtitles.length} entries`;

    const html = subtitles.map(sub => `
        <div class="subtitle-entry">
            <div class="subtitle-timestamp">${sub.timestamp}</div>
            <div class="subtitle-text">${escapeHtml(sub.text)}</div>
        </div>
    `).join('');

    subtitlesContent.innerHTML = html;
}

// Clear subtitles
function clearSubtitles() {
    showEmptyState('Select a video, translation method, and language to view subtitles');
    subtitleCount.textContent = '';
}

// Show loading state
function showLoading() {
    subtitlesContent.innerHTML = `
        <div class="loading">
            <div class="spinner"></div>
            <p>Loading subtitles...</p>
        </div>
    `;
    subtitleCount.textContent = '';
}

// Show empty state
function showEmptyState(message) {
    subtitlesContent.innerHTML = `
        <div class="empty-state">
            <div class="empty-state-icon">📝</div>
            <p>${escapeHtml(message)}</p>
        </div>
    `;
}

// Show error
function showError(message) {
    subtitlesContent.innerHTML = `
        <div class="error-message">
            <strong>Error:</strong> ${escapeHtml(message)}
        </div>
    `;
    subtitleCount.textContent = '';
}

// Escape HTML to prevent XSS
function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
}

// Initialize app when DOM is ready
if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
} else {
    init();
}
