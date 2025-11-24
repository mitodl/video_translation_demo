// Application state
let manifest = null;
let ytPlayer = null;
let subtitleData = []; // For video overlay
let englishSubtitleData = [];
let translatedSubtitleData = [];
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
const subtitlesContentEnglish = document.getElementById('subtitles-content-english');
const subtitlesContentTranslated = document.getElementById('subtitles-content-translated');
const translatedHeader = document.getElementById('translated-header');
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

    // Always load English subtitles for the selected video
    loadEnglishSubtitles();

    // Populate languages and prefer Spanish when available
    populateLanguageSelect(0);
    const availableLanguages = getAvailableLanguages(video);
    if (availableLanguages.length === 0) {
        return;
    }

    const defaultLanguage = availableLanguages.includes('es')
        ? 'es'
        : availableLanguages[0];

    currentSelection.language = defaultLanguage;
    languageSelect.value = defaultLanguage;

    // Populate methods for the default language and auto-select the first option
    populateMethodSelect(0, defaultLanguage);
    const languageMethods = getMethodsForLanguage(video, defaultLanguage);
    if (languageMethods.length === 0) {
        return;
    }

    currentSelection.method = languageMethods[0];
    methodSelect.value = currentSelection.method;

    // Load subtitles for the default selection
    loadTranslatedSubtitles();
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

function getAvailableLanguages(video) {
    const languageOrder = [];

    video.methods.forEach((method) => {
        const methodLanguages = video.languages[method] || [];
        methodLanguages.forEach((lang) => {
            if (!languageOrder.includes(lang)) {
                languageOrder.push(lang);
            }
        });
    });

    return languageOrder;
}

function getMethodsForLanguage(video, language) {
    if (!language) {
        return [];
    }

    return video.methods.filter((method) => isMethodAvailableForLanguage(video, method, language));
}

function isMethodAvailableForLanguage(video, method, language) {
    if (!video || !method || !language) {
        return false;
    }

    const methodLanguages = video.languages[method] || [];
    return methodLanguages.includes(language);
}

function formatMethodLabel(methodName, index) {
    const friendlyName = methodName
        .replace(/[_-]/g, ' ')
        .split(' ')
        .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
        .join(' ');

    return `Method ${index + 1}`;
}

// Populate method dropdown based on selected language
function populateMethodSelect(videoIndex, language) {
    methodSelect.innerHTML = '<option value="">Select a method...</option>';
    methodSelect.dataset.language = language || '';

    if (language === null || language === undefined || language === '') {
        methodSelect.disabled = true;
        return;
    }

    const video = manifest.videos[videoIndex];
    let hasMethods = false;

    video.methods.forEach((method, index) => {
        if (!isMethodAvailableForLanguage(video, method, language)) {
            return;
        }

        const option = document.createElement('option');
        option.value = method;
        option.textContent = formatMethodLabel(method, index);
        methodSelect.appendChild(option);
        hasMethods = true;
    });

    if (!hasMethods) {
        methodSelect.innerHTML = '<option value="">No methods available</option>';
        methodSelect.disabled = true;
        return;
    }

    methodSelect.disabled = false;
}

// Populate language dropdown based on video
function populateLanguageSelect(videoIndex) {
    languageSelect.innerHTML = '<option value="">Select a language...</option>';

    const video = manifest.videos[videoIndex];
    const languages = getAvailableLanguages(video);

    languages.forEach((langCode) => {
        const option = document.createElement('option');
        option.value = langCode;
        option.textContent = manifest.languageNames[langCode] || langCode;
        languageSelect.appendChild(option);
    });

    languageSelect.disabled = languages.length === 0;
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
            const previousLanguage = currentSelection.language;
            const previousMethod = currentSelection.method;

            currentSelection.video = parseInt(videoIndex, 10);
            const video = manifest.videos[currentSelection.video];

            loadVideo(video.youtubeId);
            loadEnglishSubtitles();

            populateLanguageSelect(currentSelection.video);
            const availableLanguages = getAvailableLanguages(video);

            if (previousLanguage && availableLanguages.includes(previousLanguage)) {
                currentSelection.language = previousLanguage;
                languageSelect.value = previousLanguage;
            } else {
                currentSelection.language = null;
                languageSelect.value = '';
            }

            if (currentSelection.language) {
                populateMethodSelect(currentSelection.video, currentSelection.language);
                const supportedMethods = getMethodsForLanguage(video, currentSelection.language);

                if (previousMethod && supportedMethods.includes(previousMethod)) {
                    currentSelection.method = previousMethod;
                    methodSelect.value = previousMethod;
                    loadTranslatedSubtitles();
                } else {
                    currentSelection.method = null;
                    methodSelect.value = '';
                    clearTranslatedSubtitles();
                }
            } else {
                methodSelect.innerHTML = '<option value="">Select a method...</option>';
                methodSelect.disabled = true;
                currentSelection.method = null;
                clearTranslatedSubtitles();
            }
        }
    });

    languageSelect.addEventListener('change', (e) => {
        const language = e.target.value;

        if (currentSelection.video === null) {
            languageSelect.value = '';
            return;
        }

        if (language === '') {
            currentSelection.language = null;
            currentSelection.method = null;
            methodSelect.innerHTML = '<option value="">Select a method...</option>';
            methodSelect.disabled = true;
            clearTranslatedSubtitles();
            return;
        }

        const previousMethod = currentSelection.method;
        currentSelection.language = language;

        populateMethodSelect(currentSelection.video, language);

        const video = manifest.videos[currentSelection.video];
        const methods = getMethodsForLanguage(video, language);

        if (previousMethod && methods.includes(previousMethod)) {
            currentSelection.method = previousMethod;
            methodSelect.value = previousMethod;
            loadTranslatedSubtitles();
        } else {
            currentSelection.method = null;
            methodSelect.value = '';
            clearTranslatedSubtitles();
        }
    });

    methodSelect.addEventListener('change', (e) => {
        const method = e.target.value;

        if (method === '') {
            currentSelection.method = null;
            clearTranslatedSubtitles();
            return;
        }

        if (currentSelection.video === null || !currentSelection.language) {
            methodSelect.value = '';
            return;
        }

        const video = manifest.videos[currentSelection.video];
        const isSupported = isMethodAvailableForLanguage(video, method, currentSelection.language);

        if (!isSupported) {
            currentSelection.method = null;
            methodSelect.value = '';
            clearTranslatedSubtitles();
            return;
        }

        currentSelection.method = method;
        loadTranslatedSubtitles();
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

// Load and display English subtitles
async function loadEnglishSubtitles() {
    if (currentSelection.video === null) {
        return;
    }

    showLoading('english');
    stopSubtitleUpdates();

    try {
        const video = manifest.videos[currentSelection.video];
        const subtitlePath = getSubtitlePath(video, null, 'en');

        const response = await fetch(subtitlePath);
        if (!response.ok) {
            throw new Error(`Failed to load English subtitles: ${response.status}`);
        }

        const srtContent = await response.text();
        const subtitles = parseSRT(srtContent);

        // Store English subtitle data with timing information
        englishSubtitleData = subtitles.map(sub => ({
            ...sub,
            startTime: parseTimestamp(sub.timestamp.split(' --> ')[0]),
            endTime: parseTimestamp(sub.timestamp.split(' --> ')[1])
        }));

        // Display English subtitles
        displaySubtitles(subtitles, 'english');

        console.log('English subtitles loaded:', englishSubtitleData.length, 'entries');

        // Use English for overlay if no translation selected
        if (!currentSelection.language) {
            subtitleData = englishSubtitleData;
        }

        updateSubtitleCount();

        // Start subtitle updates if video is playing
        if (ytPlayer && ytPlayer.getPlayerState) {
            const playerState = ytPlayer.getPlayerState();
            if (playerState === YT.PlayerState.PLAYING) {
                startSubtitleUpdates();
            }
        }
    } catch (error) {
        console.error('Error loading English subtitles:', error);
        showError('Failed to load English subtitles', 'english');
    }
}

// Load and display translated subtitles
async function loadTranslatedSubtitles() {
    if (currentSelection.video === null || !currentSelection.method || !currentSelection.language) {
        return;
    }

    showLoading('translated');
    stopSubtitleUpdates();

    try {
        const video = manifest.videos[currentSelection.video];
        const subtitlePath = getSubtitlePath(video, currentSelection.method, currentSelection.language);

        const response = await fetch(subtitlePath);
        if (!response.ok) {
            throw new Error(`Failed to load translated subtitles: ${response.status}`);
        }

        const srtContent = await response.text();
        const subtitles = parseSRT(srtContent);

        // Store translated subtitle data with timing information
        translatedSubtitleData = subtitles.map(sub => ({
            ...sub,
            startTime: parseTimestamp(sub.timestamp.split(' --> ')[0]),
            endTime: parseTimestamp(sub.timestamp.split(' --> ')[1])
        }));

        // Use translated subtitles for overlay
        subtitleData = translatedSubtitleData;

        // Display translated subtitles
        displaySubtitles(subtitles, 'translated');

        // Update header with language name
        const languageName = manifest.languageNames[currentSelection.language] || currentSelection.language;
        translatedHeader.textContent = languageName;

        console.log('Translated subtitles loaded:', translatedSubtitleData.length, 'entries');

        updateSubtitleCount();

        // Start subtitle updates if video is playing
        if (ytPlayer && ytPlayer.getPlayerState) {
            const playerState = ytPlayer.getPlayerState();
            if (playerState === YT.PlayerState.PLAYING) {
                startSubtitleUpdates();
            }
        }
    } catch (error) {
        console.error('Error loading translated subtitles:', error);
        showError('Failed to load translated subtitles', 'translated');
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
    const basePath = `translation/videos/${videoId}`;

    const buildPath = (folder, filename) => `${basePath}/${folder}/${filename}`;

    // For English, use the original file
    if (language === 'en') {
        return `${basePath}/${baseFilename}-en.srt`;
    }

    // Different naming conventions for different methods
    if (method === 'deep-l') {
        // deep-l uses: {baseFilename}-output-deepl-{lang}.srt
        return buildPath(method, `${baseFilename}-output-deepl-${language}.srt`);
    } else if (method === 'gpt-5') {
        // gpt-5 uses: {baseFilename}-output-gpt-5-{lang}.srt
        return buildPath(method, `${baseFilename}-output-gpt-5-${language}.srt`);
    } else if (method === 'deep-l_gpt5') {
        // deep-l_gpt5 uses: {baseFilename}-output-deepl-gpt-5-{lang}.srt
        return buildPath(method, `${baseFilename}-output-deepl-gpt-5-${language}.srt`);
    } else if (method === 'advanced') {
        // advanced uses: {baseFilename}__output_{lang}_advanced.srt
        return buildPath(method, `${baseFilename}__output_${language}_advanced.srt`);
    } else if (method === 'multi_llm') {
        // multi_llm reuses the advanced filename pattern but lives in its own folder
        return buildPath('multi_llm', `${baseFilename}__output_${language}_advanced.srt`);
    } else if (method === 'julia') {
        // julia outputs follow: output_{lang}_{runId}.srt (default runId 19 if not supplied)
        const juliaRunId = video.juliaRunId || video.juliaSuffix || '19';
        return buildPath('julia', `output_${language}_${juliaRunId}.srt`);
    } else if (method === 'gpt5') {
        // gpt5 uses: {baseFilename}__output_{lang}_gpt5.srt
        return buildPath('gpt5', `${baseFilename}__output_${language}_gpt5.srt`);
    } else if (method === 'gemini') {
        // gemini uses: {baseFilename}__output_{lang}_gemini.srt
        return buildPath('gemini', `${baseFilename}__output_${language}_gemini.srt`);
    } else {
        // gpt-4o-mini can use either pattern:
        // 1. {baseFilename}-output-gpt-4o-mini-{lang}.srt
        // 2. {baseFilename}-en_output-{lang}.srt (legacy)
        // Try the new pattern first
        return buildPath(method, `${baseFilename}-output-gpt-4o-mini-${language}.srt`);
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

// Display subtitles in specified column
function displaySubtitles(subtitles, column) {
    const container = column === 'english' ? subtitlesContentEnglish : subtitlesContentTranslated;

    if (subtitles.length === 0) {
        showEmptyState(column === 'english' ? 'No English subtitles found' : 'No translated subtitles found', column);
        return;
    }

    const html = subtitles.map(sub => `
        <div class="subtitle-entry">
            <div class="subtitle-timestamp">${sub.timestamp}</div>
            <div class="subtitle-text">${escapeHtml(sub.text)}</div>
        </div>
    `).join('');

    container.innerHTML = html;

    // Set up synchronized scrolling
    setupSyncedScrolling();
}

// Set up synchronized scrolling between subtitle columns
let syncScrollingSetup = false;
function setupSyncedScrolling() {
    if (syncScrollingSetup) return; // Only set up once
    syncScrollingSetup = true;

    let isScrolling = false;

    const syncScroll = (source, target) => {
        if (isScrolling) return;
        isScrolling = true;

        const scrollPercentage = source.scrollTop / (source.scrollHeight - source.clientHeight);
        target.scrollTop = scrollPercentage * (target.scrollHeight - target.clientHeight);

        setTimeout(() => { isScrolling = false; }, 50);
    };

    const englishContainer = document.getElementById('subtitles-content-english');
    const translatedContainer = document.getElementById('subtitles-content-translated');

    englishContainer.addEventListener('scroll', () => syncScroll(englishContainer, translatedContainer));
    translatedContainer.addEventListener('scroll', () => syncScroll(translatedContainer, englishContainer));
}

// Update subtitle count
function updateSubtitleCount() {
    const englishCount = englishSubtitleData.length;
    const translatedCount = translatedSubtitleData.length;

    if (englishCount > 0 && translatedCount > 0) {
        subtitleCount.textContent = `English: ${englishCount} entries | Translated: ${translatedCount} entries`;
    } else if (englishCount > 0) {
        subtitleCount.textContent = `English: ${englishCount} entries`;
    } else if (translatedCount > 0) {
        subtitleCount.textContent = `Translated: ${translatedCount} entries`;
    } else {
        subtitleCount.textContent = '';
    }
}

// Clear all subtitles
function clearSubtitles() {
    showEmptyState('Select a video to view English subtitles', 'english');
    showEmptyState('Select a language and translation method', 'translated');
    subtitleCount.textContent = '';
    subtitleData = [];
    englishSubtitleData = [];
    translatedSubtitleData = [];
    translatedHeader.textContent = 'Translation';
    stopSubtitleUpdates();
}

// Clear only translated subtitles
function clearTranslatedSubtitles() {
    showEmptyState('Select a language and translation method', 'translated');
    translatedSubtitleData = [];
    subtitleData = englishSubtitleData; // Fall back to English for overlay
    translatedHeader.textContent = 'Translation';
    updateSubtitleCount();
}

// Show loading state
function showLoading(column) {
    const container = column === 'english' ? subtitlesContentEnglish : subtitlesContentTranslated;
    container.innerHTML = `
        <div class="loading">
            <div class="spinner"></div>
            <p>Loading subtitles...</p>
        </div>
    `;
}

// Show empty state
function showEmptyState(message, column) {
    const container = column === 'english' ? subtitlesContentEnglish : subtitlesContentTranslated;
    const icon = column === 'english' ? '📝' : '🌍';
    container.innerHTML = `
        <div class="empty-state">
            <div class="empty-state-icon">${icon}</div>
            <p>${escapeHtml(message)}</p>
        </div>
    `;
}

// Show error
function showError(message, column) {
    const container = column === 'english' ? subtitlesContentEnglish : subtitlesContentTranslated;
    container.innerHTML = `
        <div class="error-message">
            <strong>Error:</strong> ${escapeHtml(message)}
        </div>
    `;
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
