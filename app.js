// Application state
let manifest = null;
let ytPlayer = null;
let subtitleData = [];
let subtitleUpdateInterval = null;
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
const subtitleOverlayText = document.getElementById('subtitle-overlay-text');

// YouTube API ready flag
let youtubeAPIReady = false;

// Called automatically when YouTube IFrame API is ready
function onYouTubeIframeAPIReady() {
    youtubeAPIReady = true;
    console.log('YouTube API ready');
}

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

        // Wait for YouTube API to be ready, then set defaults
        waitForYouTubeAPI();
    } catch (error) {
        console.error('Failed to initialize app:', error);
        showError('Failed to load application data');
    }
}

// Wait for YouTube API to be ready
function waitForYouTubeAPI() {
    if (youtubeAPIReady || (window.YT && window.YT.Player)) {
        setDefaults();
    } else {
        setTimeout(waitForYouTubeAPI, 100);
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
            const previousMethod = currentSelection.method;
            const previousLanguage = currentSelection.language;

            currentSelection.video = parseInt(videoIndex);
            const video = manifest.videos[videoIndex];

            // Populate method dropdown
            populateMethodSelect(videoIndex);

            // Try to preserve method selection if it exists for this video
            if (previousMethod && video.languages[previousMethod] && video.languages[previousMethod].length > 0) {
                currentSelection.method = previousMethod;
                methodSelect.value = previousMethod;

                // Populate language dropdown for the preserved method
                populateLanguageSelect(videoIndex, previousMethod);

                // Try to preserve language selection if it exists for this method
                if (previousLanguage && video.languages[previousMethod].includes(previousLanguage)) {
                    currentSelection.language = previousLanguage;
                    languageSelect.value = previousLanguage;
                    loadSubtitles();
                } else {
                    currentSelection.language = null;
                    clearSubtitles();
                }
            } else {
                currentSelection.method = null;
                currentSelection.language = null;
                languageSelect.disabled = true;
                languageSelect.innerHTML = '<option value="">Select a language...</option>';
                clearSubtitles();
            }

            loadVideo(video.youtubeId);
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
            const previousLanguage = currentSelection.language;
            currentSelection.method = method;

            const video = manifest.videos[currentSelection.video];
            populateLanguageSelect(currentSelection.video, method);

            // Try to preserve language selection if it exists for this method
            if (previousLanguage && video.languages[method].includes(previousLanguage)) {
                currentSelection.language = previousLanguage;
                languageSelect.value = previousLanguage;
                loadSubtitles();
            } else {
                currentSelection.language = null;
                clearSubtitles();
            }
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

// Load video using YouTube IFrame API
function loadVideo(youtubeId) {
    // Clear any existing player
    if (ytPlayer) {
        ytPlayer.destroy();
    }

    // Stop subtitle updates
    stopSubtitleUpdates();

    // Create player container
    videoContainer.innerHTML = `
        <div id="youtube-player"></div>
        <div id="subtitle-overlay" class="subtitle-overlay">
            <div id="subtitle-overlay-text" class="subtitle-overlay-text" style="display: none;"></div>
        </div>
    `;

    // Create YouTube player
    ytPlayer = new YT.Player('youtube-player', {
        height: '100%',
        width: '100%',
        videoId: youtubeId,
        playerVars: {
            'playsinline': 1,
            'modestbranding': 1,
            'rel': 0,
            'cc_load_policy': 0,  // Disable YouTube's native captions
            'iv_load_policy': 3   // Disable annotations
        },
        events: {
            'onReady': onPlayerReady,
            'onStateChange': onPlayerStateChange
        }
    });
}

// Player ready callback
function onPlayerReady(event) {
    console.log('Player ready for video');

    // If we already have subtitles loaded and video is playing, start updates
    if (subtitleData.length > 0) {
        const playerState = ytPlayer.getPlayerState();
        if (playerState === YT.PlayerState.PLAYING) {
            startSubtitleUpdates();
        }
    }
}

// Player state change callback
function onPlayerStateChange(event) {
    // YT.PlayerState.PLAYING = 1
    if (event.data === YT.PlayerState.PLAYING) {
        startSubtitleUpdates();
    } else {
        stopSubtitleUpdates();
    }
}

// Start subtitle updates
function startSubtitleUpdates() {
    if (subtitleData.length === 0) {
        console.log('No subtitle data available');
        return;
    }

    stopSubtitleUpdates();

    console.log('Starting subtitle updates with', subtitleData.length, 'subtitles');

    subtitleUpdateInterval = setInterval(() => {
        if (ytPlayer && ytPlayer.getCurrentTime) {
            const currentTime = ytPlayer.getCurrentTime();
            updateSubtitleOverlay(currentTime);
        }
    }, 100); // Update every 100ms for smooth subtitle display
}

// Stop subtitle updates
function stopSubtitleUpdates() {
    if (subtitleUpdateInterval) {
        clearInterval(subtitleUpdateInterval);
        subtitleUpdateInterval = null;
    }
    hideSubtitleOverlay();
}

// Update subtitle overlay based on current time
function updateSubtitleOverlay(currentTimeSeconds) {
    const currentTimeMs = currentTimeSeconds * 1000;

    // Find the current subtitle
    const currentSub = subtitleData.find(sub => {
        return currentTimeMs >= sub.startTime && currentTimeMs <= sub.endTime;
    });

    if (currentSub) {
        showSubtitleOverlay(currentSub.text);
    } else {
        hideSubtitleOverlay();
    }
}

// Show subtitle overlay
function showSubtitleOverlay(text) {
    const overlayElement = document.getElementById('subtitle-overlay-text');
    if (overlayElement) {
        overlayElement.textContent = text;
        overlayElement.style.display = 'inline-block';
    } else {
        console.warn('Subtitle overlay element not found');
    }
}

// Hide subtitle overlay
function hideSubtitleOverlay() {
    const overlayElement = document.getElementById('subtitle-overlay-text');
    if (overlayElement) {
        overlayElement.style.display = 'none';
    }
}

// Clear video
function clearVideo() {
    if (ytPlayer) {
        ytPlayer.destroy();
        ytPlayer = null;
    }
    stopSubtitleUpdates();
    videoContainer.innerHTML = '';
}

// Load and display subtitles
async function loadSubtitles() {
    if (currentSelection.video === null || !currentSelection.method || !currentSelection.language) {
        return;
    }

    showLoading();
    stopSubtitleUpdates();

    try {
        const video = manifest.videos[currentSelection.video];
        const subtitlePath = getSubtitlePath(video, currentSelection.method, currentSelection.language);

        const response = await fetch(subtitlePath);
        if (!response.ok) {
            throw new Error(`Failed to load subtitles: ${response.status}`);
        }

        const srtContent = await response.text();
        const subtitles = parseSRT(srtContent);

        // Store subtitle data with timing information
        subtitleData = subtitles.map(sub => ({
            ...sub,
            startTime: parseTimestamp(sub.timestamp.split(' --> ')[0]),
            endTime: parseTimestamp(sub.timestamp.split(' --> ')[1])
        }));

        // Display subtitles in the transcript area below
        displaySubtitles(subtitles);

        console.log('Subtitles loaded:', subtitleData.length, 'entries');

        // Start subtitle updates if video is playing
        if (ytPlayer && ytPlayer.getPlayerState) {
            const playerState = ytPlayer.getPlayerState();
            console.log('Player state:', playerState);
            if (playerState === YT.PlayerState.PLAYING) {
                startSubtitleUpdates();
            }
        }
    } catch (error) {
        console.error('Error loading subtitles:', error);
        showError('Failed to load subtitles');
    }
}

// Parse SRT timestamp to milliseconds
function parseTimestamp(timestamp) {
    const parts = timestamp.match(/(\d{2}):(\d{2}):(\d{2}),(\d{3})/);
    if (!parts) return 0;

    const hours = parseInt(parts[1]);
    const minutes = parseInt(parts[2]);
    const seconds = parseInt(parts[3]);
    const milliseconds = parseInt(parts[4]);

    return (hours * 3600 + minutes * 60 + seconds) * 1000 + milliseconds;
}

// Get subtitle file path
function getSubtitlePath(video, method, language) {
    const videoId = video.id;
    const baseFilename = video.baseFilename || videoId;

    // For English, use the original file
    if (language === 'en') {
        return `translation/videos/${videoId}/${baseFilename}-en.srt`;
    }

    // Different naming conventions for different methods
    if (method === 'deep-l') {
        // deep-l uses: {baseFilename}-output-deepl-{lang}.srt
        return `translation/videos/${videoId}/${method}/${baseFilename}-output-deepl-${language}.srt`;
    } else if (method === 'gpt-5') {
        // gpt-5 uses: {baseFilename}-output-gpt-5-{lang}.srt
        // BUT for L2.1, it uses the hybrid format: {baseFilename}-output-deepl-gpt-5-{lang}.srt
        if (videoId === 'L2.1.HAIM_Holistic_AI_for_Medicine') {
            return `translation/videos/${videoId}/${method}/${baseFilename}-output-deepl-gpt-5-${language}.srt`;
        }
        return `translation/videos/${videoId}/${method}/${baseFilename}-output-gpt-5-${language}.srt`;
    } else if (method === 'deep-l_gpt5') {
        // deep-l_gpt5 uses: {baseFilename}-output-deepl-gpt-5-{lang}.srt
        return `translation/videos/${videoId}/${method}/${baseFilename}-output-deepl-gpt-5-${language}.srt`;
    } else {
        // gpt-4o-mini uses: {baseFilename}-en_output-{lang}.srt
        return `translation/videos/${videoId}/${method}/${baseFilename}-en_output-${language}.srt`;
    }
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
    subtitleData = [];
    stopSubtitleUpdates();
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
