const ERP_URL = 'https://genex.thesmarterp.com';
const API_KEY = '7941a0a93e2a171';
const API_SECRET = 'c41c3cbee71760b';

let currentStudent = null;
let courses = [];
let currentCourse = null;
let currentVideos = [];
let isKeyUsed = false;
let guardianInterval = null;
let isWatermarkInjected = false;

// Windows registry for credential storage
const { ipcRenderer } = require('electron');

function getAuthHeader() {
    return 'token ' + API_KEY + ':' + API_SECRET;
}

function getYouTubeVideoId(url) {
    if (!url) return null;
    const patterns = [
        /(?:youtube\.com\/watch\?v=|youtu\.be\/|youtube\.com\/embed\/)([^&\?\/]+)/,
        /^([a-zA-Z0-9_-]{11})$/
    ];
    
    for (let pattern of patterns) {
        const match = url.match(pattern);
        if (match && match[1]) {
            return match[1];
        }
    }
    return null;
}

function showError(message) {
    const errorEl = document.getElementById('loginError');
    errorEl.textContent = message;
    errorEl.classList.add('show');
}

function hideError() {
    const errorEl = document.getElementById('loginError');
    errorEl.classList.remove('show');
}

function getInitials(firstName, lastName) {
    const first = (firstName || '').charAt(0).toUpperCase();
    const last = (lastName || '').charAt(0).toUpperCase();
    return first + last || '??';
}

// Check if course has expired
function isCourseExpired(expiryDate) {
    if (!expiryDate) return false;
    
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    
    const expiry = new Date(expiryDate);
    expiry.setHours(0, 0, 0, 0);
    
    return today > expiry;
}

// Format expiry date for display
function formatExpiryDate(expiryDate) {
    if (!expiryDate) return 'No Expiry';
    
    const expiry = new Date(expiryDate);
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    expiry.setHours(0, 0, 0, 0);
    
    const diffTime = expiry - today;
    const diffDays = Math.ceil(diffTime / (1000 * 60 * 60 * 24));
    
    if (diffDays < 0) {
        return 'Expired';
    } else if (diffDays === 0) {
        return 'Expires Today';
    } else if (diffDays === 1) {
        return 'Expires Tomorrow';
    } else if (diffDays <= 7) {
        return `${diffDays} days left`;
    } else if (diffDays <= 30) {
        return `${diffDays} days left`;
    } else {
        const options = { year: 'numeric', month: 'short', day: 'numeric' };
        return `Until ${expiry.toLocaleDateString('en-US', options)}`;
    }
}

// Mark private key as used in ERPNext
async function markKeyAsUsed(studentName, keyRow) {
    try {
        console.log('Marking key as used:', {
            studentName: studentName,
            keyRow: keyRow
        });
        
        // Child table DocType name is "custom_key_details"
        const url = `${ERP_URL}/api/resource/Key Details/${encodeURIComponent(keyRow)}`;
        
        console.log('API URL:', url);
        
        const response = await fetch(url, {
            method: 'PUT',
            headers: {
                'Authorization': getAuthHeader(),
                'Content-Type': 'application/json',
                'Accept': 'application/json'
            },
            body: JSON.stringify({
                is_key_used: 1
            })
        });
        
        console.log('Response status:', response.status);
        
        if (response.ok) {
            const result = await response.json();
            console.log('✅ Key marked as used successfully:', result);
        } else {
            const errorText = await response.text();
            console.error('❌ Failed to mark key as used:', response.status, errorText);
        }
    } catch (error) {
        console.error('❌ Error marking key as used:', error);
    }
}

document.getElementById('loginForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    hideError();
    
    const email = document.getElementById('emailInput').value.trim();
    const password = document.getElementById('passwordInput').value.trim();
    const privateKey = document.getElementById('privateKeyInput').value.trim();
    const loginBtn = document.getElementById('loginBtn');
    
    loginBtn.disabled = true;
    loginBtn.textContent = '🔄 Verifying credentials...';

    try {
        // Step 1: Get basic student info
        const filters = JSON.stringify([["student_email_id", "=", email]]);
        const fields = JSON.stringify(["name", "student_email_id", "custom_password", "first_name", "last_name", "enabled"]);
        
        const url = `${ERP_URL}/api/resource/Student?fields=${encodeURIComponent(fields)}&filters=${encodeURIComponent(filters)}`;
        
        const response = await fetch(url, {
            method: 'GET',
            headers: {
                'Authorization': getAuthHeader(),
                'Content-Type': 'application/json',
                'Accept': 'application/json'
            }
        });

        if (!response.ok) {
            throw new Error('Failed to connect to server');
        }

        const data = await response.json();
        
        if (!data.data || data.data.length === 0) {
            throw new Error('Invalid email address');
        }

        const student = data.data[0];
        
        if (student.enabled === 0) {
            throw new Error('Your account has been disabled. Please contact administrator.');
        }
        
        if (!student.custom_password) {
            throw new Error('No password set. Contact administrator.');
        }
        
        const storedPassword = String(student.custom_password).trim();
        const enteredPassword = String(password).trim();
        
        if (storedPassword !== enteredPassword) {
            throw new Error('Invalid password');
        }
        
        // Step 2: Fetch full student document with custom_keys child table
        const studentUrl = `${ERP_URL}/api/resource/Student/${encodeURIComponent(student.name)}`;
        
        const studentResponse = await fetch(studentUrl, {
            method: 'GET',
            headers: {
                'Authorization': getAuthHeader(),
                'Content-Type': 'application/json',
                'Accept': 'application/json'
            }
        });

        if (!studentResponse.ok) {
            throw new Error('Failed to load student data');
        }

        const studentData = await studentResponse.json();
        const fullStudent = studentData.data;
        
        // Step 3: Check custom_keys child table
        const customKeys = fullStudent.custom_key_details || [];
        
        if (customKeys.length === 0) {
            throw new Error('No private keys assigned. Contact administrator.');
        }
        
        // Find matching key that is not used and not deactivated
        const enteredKey = String(privateKey).trim();
        let matchedKey = null;
        
        for (const keyRow of customKeys) {
            const storedKey = String(keyRow.private_key || '').trim();
            
            if (storedKey === enteredKey) {
                // Found matching key
                if (keyRow.deactivated === 1) {
                    throw new Error('This private key has been deactivated. Contact administrator for a new key.');
                }
                
                if (keyRow.is_key_used === 1) {
                    throw new Error('This private key has already been used. Contact administrator for a new key.');
                }
                
                // Valid key found!
                matchedKey = keyRow;
                break;
            }
        }
        
        if (!matchedKey) {
            throw new Error('Invalid private key');
        }
        
        // Step 4: Mark this specific key as used
        await markKeyAsUsed(student.name, matchedKey.name);
        
        currentStudent = fullStudent;
        isKeyUsed = true;
        
        await ipcRenderer.invoke('save-credentials', {
            email: email,
            password: password,
            privateKey: privateKey,
            studentData: JSON.stringify(fullStudent)
        });
        
        document.getElementById('studentName').textContent = 
            `${fullStudent.first_name} ${fullStudent.last_name || ''}`;
        document.getElementById('studentInitials').textContent = 
            getInitials(fullStudent.first_name, fullStudent.last_name);
        
        document.querySelector('.logout-btn').style.display = 'none';
        
        document.getElementById('loginScreen').classList.add('hidden');
        document.getElementById('mainScreen').classList.remove('hidden');
        
        loadCourses();
        
    } catch (error) {
        showError(error.message);
    } finally {
        loginBtn.disabled = false;
        loginBtn.textContent = 'Verify & Login';
    }
});

// Check for saved credentials on load
window.addEventListener('DOMContentLoaded', async () => {
    console.log('Student Video Player loaded');
    
    const logoImg = document.getElementById('companyLogo');
    const logoFallback = document.getElementById('logoFallback');
    
    if (logoImg) {
        logoImg.onerror = function() {
            logoImg.style.display = 'none';
            if (logoFallback) {
                logoFallback.classList.add('active');
            }
        };
        
        logoImg.onload = function() {
            logoImg.style.display = 'block';
            if (logoFallback) {
                logoFallback.classList.remove('active');
            }
        };
        
        if (!logoImg.complete || logoImg.naturalWidth === 0) {
            logoImg.onerror();
        }
    }
    
    const savedCreds = await ipcRenderer.invoke('get-credentials');
    
    if (savedCreds && savedCreds.email && savedCreds.studentData) {
        try {
            const studentData = JSON.parse(savedCreds.studentData);
            
            // Verify student is still enabled
            const filters = JSON.stringify([["student_email_id", "=", savedCreds.email]]);
            const fields = JSON.stringify(["name", "student_email_id", "first_name", "last_name", "enabled"]);
            
            const url = `${ERP_URL}/api/resource/Student?fields=${encodeURIComponent(fields)}&filters=${encodeURIComponent(filters)}`;
            
            const response = await fetch(url, {
                method: 'GET',
                headers: {
                    'Authorization': getAuthHeader(),
                    'Content-Type': 'application/json',
                    'Accept': 'application/json'
                }
            });
            
            if (!response.ok) {
                throw new Error('Cannot verify student status');
            }
            
            const data = await response.json();
            
            if (!data.data || data.data.length === 0) {
                await ipcRenderer.invoke('clear-credentials');
                console.log('Student record not found - credentials cleared');
                return;
            }
            
            const student = data.data[0];
            
            if (student.enabled === 0) {
                await ipcRenderer.invoke('clear-credentials');
                showError('Your account has been disabled. Please contact administrator.');
                console.log('Student account disabled - credentials cleared');
                return;
            }
            
            // Fetch full student document with custom_keys
            const studentUrl = `${ERP_URL}/api/resource/Student/${encodeURIComponent(student.name)}`;
            
            const studentResponse = await fetch(studentUrl, {
                method: 'GET',
                headers: {
                    'Authorization': getAuthHeader(),
                    'Content-Type': 'application/json',
                    'Accept': 'application/json'
                }
            });

            if (!studentResponse.ok) {
                throw new Error('Failed to load student data');
            }

            const fullStudentData = await studentResponse.json();
            const fullStudent = fullStudentData.data;
            
            // Verify the saved private key is still valid
            const customKeys = fullStudent.custom_key_details || [];
            const savedKey = savedCreds.privateKey;
            let keyStillValid = false;
            
            for (const keyRow of customKeys) {
                if (String(keyRow.private_key || '').trim() === savedKey) {
                    // Check if key is deactivated
                    if (keyRow.deactivated === 1) {
                        await ipcRenderer.invoke('clear-credentials');
                        showError('Your private key has been deactivated. Please login with a new key.');
                        console.log('Key deactivated - credentials cleared');
                        return;
                    }
                    keyStillValid = true;
                    break;
                }
            }
            
            if (!keyStillValid) {
                await ipcRenderer.invoke('clear-credentials');
                showError('Your private key is no longer valid. Please login again.');
                console.log('Key no longer valid - credentials cleared');
                return;
            }
            
            currentStudent = fullStudent;
            
            document.getElementById('studentName').textContent = 
                `${currentStudent.first_name} ${currentStudent.last_name || ''}`;
            document.getElementById('studentInitials').textContent = 
                getInitials(currentStudent.first_name, currentStudent.last_name);
            
            document.querySelector('.logout-btn').style.display = 'none';
            
            document.getElementById('loginScreen').classList.add('hidden');
            document.getElementById('mainScreen').classList.remove('hidden');
            
            loadCourses();
        } catch (error) {
            console.error('Auto-login failed:', error);
            await ipcRenderer.invoke('clear-credentials');
        }
    }
});

async function loadCourses() {
    const loadingEl = document.getElementById('loadingCourses');
    const gridEl = document.getElementById('coursesGrid');
    const noCoursesEl = document.getElementById('noCourses');
    
    loadingEl.classList.remove('hidden');
    gridEl.innerHTML = '';
    noCoursesEl.classList.add('hidden');

    try {
        const url = `${ERP_URL}/api/resource/Student/${encodeURIComponent(currentStudent.name)}`;
        
        console.log('Fetching student with courses:', currentStudent.name);
        
        const response = await fetch(url, {
            headers: {
                'Authorization': getAuthHeader(),
                'Content-Type': 'application/json'
            }
        });

        if (!response.ok) {
            throw new Error('Failed to load student data');
        }

        const data = await response.json();
        const studentData = data.data;
        
        const studentCourses = studentData.custom_courses || [];
        
        console.log('Student courses:', studentCourses);
        
        if (studentCourses.length === 0) {
            loadingEl.classList.add('hidden');
            noCoursesEl.classList.remove('hidden');
            document.querySelector('#noCourses h3').textContent = 'No Courses Assigned';
            document.querySelector('#noCourses p').textContent = 'You do not have access to any courses yet. Please contact your administrator.';
            return;
        }
        
        const coursePromises = studentCourses
            .filter(sc => !isCourseExpired(sc.expiry_date))
            .map(async (studentCourse) => {
                try {
                    const courseResponse = await fetch(
                        `${ERP_URL}/api/resource/Course/${encodeURIComponent(studentCourse.course)}?fields=["name","course_name"]`,
                        {
                            headers: {
                                'Authorization': getAuthHeader(),
                                'Content-Type': 'application/json'
                            }
                        }
                    );
                    
                    if (courseResponse.ok) {
                        const courseData = await courseResponse.json();
                        return {
                            ...courseData.data,
                            expiry_date: studentCourse.expiry_date
                        };
                    }
                    return null;
                } catch (error) {
                    console.error('Error fetching course:', studentCourse.course, error);
                    return null;
                }
            });
        
        const fetchedCourses = await Promise.all(coursePromises);
        courses = fetchedCourses.filter(c => c !== null);
        
        console.log('Loaded active courses:', courses);
        
        loadingEl.classList.add('hidden');
        
        if (courses.length === 0) {
            noCoursesEl.classList.remove('hidden');
            document.querySelector('#noCourses h3').textContent = 'No Active Courses';
            document.querySelector('#noCourses p').textContent = 'All your courses have expired. Please contact your administrator.';
        } else {
            displayCourses(courses);
        }
        
    } catch (error) {
        loadingEl.classList.add('hidden');
        console.error('Error loading courses:', error);
        noCoursesEl.classList.remove('hidden');
        document.querySelector('#noCourses h3').textContent = 'Error Loading Courses';
        document.querySelector('#noCourses p').textContent = 'Unable to load your courses. Please check your internet connection.';
    }
}

function getCourseIcon(courseName) {
    const name = (courseName || '').toLowerCase();
    
    if (name.includes('basic') || name.includes('beginner') || name.includes('intro')) return '🎯';
    if (name.includes('advanced') || name.includes('pro') || name.includes('expert')) return '🚀';
    if (name.includes('technical') || name.includes('analysis')) return '📊';
    if (name.includes('strategy') || name.includes('trading')) return '📈';
    if (name.includes('risk') || name.includes('management')) return '🛡️';
    if (name.includes('psychology') || name.includes('mindset')) return '🧠';
    if (name.includes('fundamental')) return '📈';
    if (name.includes('crypto') || name.includes('bitcoin')) return '₿';
    if (name.includes('forex')) return '💱';
    if (name.includes('stock') || name.includes('equity')) return '📉';
    
    return '📚';
}

function displayCourses(courseList) {
    const gridEl = document.getElementById('coursesGrid');
    gridEl.innerHTML = '';
    
    const existingHeader = document.querySelector('.content-header');
    if (existingHeader) existingHeader.remove();
    
    const header = document.createElement('div');
    header.className = 'content-header';
    header.innerHTML = `
        <h2>📚 Trading Courses</h2>
        <p>Master the markets with our comprehensive trading curriculum</p>
    `;
    gridEl.parentElement.insertBefore(header, gridEl);
    
    courseList.forEach((course, index) => {
        const card = document.createElement('div');
        card.className = 'course-card';
        card.style.opacity = '0';
        card.onclick = () => loadCourseVideos(course);
        
        const icon = getCourseIcon(course.course_name);
        const expiryText = formatExpiryDate(course.expiry_date);
        const isExpiringSoon = course.expiry_date && !isCourseExpired(course.expiry_date) && 
                               (new Date(course.expiry_date) - new Date()) / (1000 * 60 * 60 * 24) <= 7;
        
        card.innerHTML = `
            <div class="course-icon">${icon}</div>
            <h3>${course.course_name || course.name}</h3>
            <p>Click to view course videos • Professional trading education</p>
            <div class="course-meta">
                <div class="course-meta-item">
                    <span>📹</span>
                    <span>Video Lectures</span>
                </div>
                <div class="course-meta-item">
                    <span>⏰</span>
                    <span>${expiryText}</span>
                </div>
            </div>
            <span class="status-badge ${isExpiringSoon ? 'status-warning' : 'status-new'}">
                ${isExpiringSoon ? '⚠️ EXPIRING SOON' : 'AVAILABLE'}
            </span>
        `;
        
        gridEl.appendChild(card);
        
        setTimeout(() => {
            card.style.transition = 'opacity 0.5s ease-out';
            card.style.opacity = '1';
        }, index * 100);
    });
}

async function loadCourseVideos(course) {
    currentCourse = course;
    
    document.getElementById('courseList').classList.add('hidden');
    document.getElementById('videoListScreen').classList.remove('hidden');
    
    document.getElementById('courseTitle').textContent = course.course_name || course.name;
    document.getElementById('courseTitleIcon').textContent = getCourseIcon(course.course_name);
    
    const loadingEl = document.getElementById('loadingVideos');
    const videosEl = document.getElementById('videosList');
    const noVideosEl = document.getElementById('noVideos');
    
    loadingEl.classList.remove('hidden');
    videosEl.innerHTML = '';
    noVideosEl.classList.add('hidden');
    
    try {
        const url = `${ERP_URL}/api/resource/Course/${encodeURIComponent(course.name)}`;
        
        console.log('Fetching course with topics:', course.name);
        
        const response = await fetch(url, {
            headers: {
                'Authorization': getAuthHeader(),
                'Content-Type': 'application/json'
            }
        });

        if (!response.ok) {
            throw new Error('Failed to load course');
        }

        const data = await response.json();
        const courseData = data.data;
        
        // Check for live class link (Zoom/Google Meet)
        const liveClassLink = courseData.custom_youtube_link;
        checkAndShowLiveClassButton(liveClassLink);
        
        const topics = courseData.topics || [];
        
        currentVideos = topics
            .filter(topic => topic.custom_video_link && topic.custom_video_link.trim() !== '')
            .map((topic, index) => ({
                name: topic.name,
                title: topic.topic_name || `Video ${index + 1}`,
                url: topic.custom_video_link,
                idx: topic.idx || index + 1
            }));
        
        console.log('Loaded videos from topics:', currentVideos);
        
        loadingEl.classList.add('hidden');
        
        if (currentVideos.length === 0) {
            noVideosEl.classList.remove('hidden');
            document.querySelector('#noVideos h3').textContent = 'No Videos Available';
            document.querySelector('#noVideos p').textContent = 'This course doesn\'t have any video links yet. Please contact your administrator.';
        } else {
            displayVideos(currentVideos);
        }
        
    } catch (error) {
        loadingEl.classList.add('hidden');
        console.error('Error loading videos:', error);
        alert('Error loading videos: ' + error.message);
    }
}

function displayVideos(videoList) {
    const videosEl = document.getElementById('videosList');
    videosEl.innerHTML = '';
    
    videoList.forEach((video, index) => {
        const videoCard = document.createElement('div');
        videoCard.className = 'video-item';
        videoCard.onclick = () => playVideo(video, index);
        
        videoCard.innerHTML = `
            <div class="video-number">${index + 1}</div>
            <div class="video-info">
                <h4>${video.title || video.name}</h4>
                <p>Lecture ${index + 1} • Click to watch</p>
            </div>
            <div class="video-play-icon">▶️</div>
        `;
        
        videosEl.appendChild(videoCard);
    });
}

// Store current webview listener references so we can remove them cleanly
let _wvListeners = null;
let _domReady = false;  // true only after dom-ready has fired for the current page

function _removeWebviewListeners() {
    if (!_wvListeners) return;
    const wv = document.getElementById('videoFrame');
    if (!wv) { _wvListeners = null; return; }
    wv.removeEventListener('will-navigate',            _wvListeners.willNavigate);
    wv.removeEventListener('did-start-loading',        _wvListeners.didStartLoading);
    wv.removeEventListener('dom-ready',                _wvListeners.domReady);
    wv.removeEventListener('enter-html-full-screen',   _wvListeners.enterFS);
    wv.removeEventListener('leave-html-full-screen',   _wvListeners.leaveFS);
    wv.removeEventListener('contextmenu',              _wvListeners.ctxMenu);
    wv.removeEventListener('new-window',               _wvListeners.newWin);
    _wvListeners = null;
}

function playVideo(video, index) {
    const videoId = getYouTubeVideoId(video.url);
    
    if (!videoId) {
        alert('Invalid video link');
        return;
    }
    
    console.log('Playing video:', video.title);
    
    // Reset injection state
    isWatermarkInjected = false;

    // Stop any active guardian before touching the webview
    if (guardianInterval) {
        clearInterval(guardianInterval);
        guardianInterval = null;
    }

    // Remove ALL previous listeners BEFORE we touch src
    _removeWebviewListeners();
    
    // Show loading screen while we prepare the video
    document.getElementById('videoListScreen').classList.add('hidden');
    document.getElementById('videoPlayer').classList.add('hidden');
    document.getElementById('videoLoadingScreen').classList.remove('hidden');
    
    document.getElementById('currentVideoTitle').textContent = video.title || video.name;
    document.getElementById('videoProgress').textContent = `Video ${index + 1} of ${currentVideos.length}`;
    
    updatePlaylist(index);
    addFloatingWatermark();

    const wv = document.getElementById('videoFrame');

    // --- build named handler refs ---
    const handlers = {};

    handlers.willNavigate = (e) => {
        // Allow the embed URL through; block everything else (Share links etc.)
        if (e.url.includes('youtube') && e.url.includes('/embed/')) return;
        e.preventDefault();
    };

    handlers.didStartLoading = () => {
        _domReady = false;
    };

    handlers.domReady = () => {
        _domReady = true;
        console.log('DOM ready - injecting CSS + watermark');
        
        // Inject Share-hiding CSS
        injectHidingCSS(wv);
        
        // Wait 100ms for CSS to parse and apply, then show the player
        setTimeout(() => {
            document.getElementById('videoLoadingScreen').classList.add('hidden');
            document.getElementById('videoPlayer').classList.remove('hidden');
            
            // Show the 3-dot button
            const dotBtn = document.getElementById('tam-dots-btn');
            if (dotBtn) dotBtn.classList.add('visible');
        }, 100);
        
        // Inject watermark
        setTimeout(() => {
            injectWatermarkIntoWebview(wv);
            isWatermarkInjected = true;
            startWatermarkGuardian(wv);
        }, 500);
    };

    handlers.enterFS = () => {
        console.log('Entered fullscreen – injecting watermark');
        setTimeout(() => injectWatermarkIntoWebview(wv), 500);
        setTimeout(() => injectWatermarkIntoWebview(wv), 1200);
        setTimeout(() => injectWatermarkIntoWebview(wv), 2000);
    };

    handlers.leaveFS = () => {
        console.log('Left fullscreen – re-injecting watermark');
        setTimeout(() => injectWatermarkIntoWebview(wv), 500);
    };

    handlers.ctxMenu = (e) => {
        e.preventDefault();
        return false;
    };

    handlers.newWin = (e) => {
        e.preventDefault();
    };

    // --- attach them ---
    wv.addEventListener('will-navigate',            handlers.willNavigate);
    wv.addEventListener('did-start-loading',        handlers.didStartLoading);
    wv.addEventListener('dom-ready',                handlers.domReady);
    wv.addEventListener('enter-html-full-screen',   handlers.enterFS);
    wv.addEventListener('leave-html-full-screen',   handlers.leaveFS);
    wv.addEventListener('contextmenu',              handlers.ctxMenu);
    wv.addEventListener('new-window',               handlers.newWin);

    // Save refs for next cleanup
    _wvListeners = handlers;

    const embedUrl = `https://www.youtube.com/embed/${videoId}?autoplay=1&rel=0&modestbranding=1&controls=1&fs=1&iv_load_policy=3&playsinline=1`;
    wv.src = embedUrl;
}

// ── injectHidingCSS — hides Share + other YouTube overlay buttons ─────────
// Runs once on dom-ready.  The shield on the outer page already covered the
// initial flash; this CSS keeps Share hidden for any subsequent auto-show
// (e.g. when the user hovers over the player controls).
function injectHidingCSS(webview) {
    if (!_domReady) return;

    const cssScript = `
(function() {
    var STYLE_ID = 'wm-hide-yt';
    var existing = document.getElementById(STYLE_ID);
    if (existing) existing.remove();

    var s = document.createElement('style');
    s.id = STYLE_ID;
    s.textContent =
        '.ytp-youtube-button,' +
        '.ytp-watermark,' +
        '.ytp-title-link,' +
        '.ytp-title,' +
        '.ytp-share-button,' +
        '.ytp-watch-later-button,' +
        '.ytp-cards-button,' +
        '.ytp-cards-teaser,' +
        '.ytp-ce-element,' +
        '.ytp-endscreen-content,' +
        '.ytp-pause-overlay,' +
        '.ytp-chrome-top-buttons,' +
        '.ytp-chrome-top,' +
        '.ytp-contextmenu,' +
        '.ytp-copylink-button,' +
        '.ytp-copylink-icon,' +
        '.ytp-impression-link,' +
        '.ytp-title-text,' +
        '.ytp-title-channel,' +
        '.ytp-watch-on-youtube,' +
        '.ytp-share-button-group,' +
        '.ytp-expand-btn,' +
        '.ytp-player-info-panel,' +
        '[data-tooltip-text*="Watch on YouTube"],' +
        '[aria-label*="Watch on YouTube"],' +
        '[aria-label*="watch on YouTube"],' +
        '[title*="Watch on YouTube"],' +
        '[title*="Copy link"],' +
        '[aria-label*="Copy link"],' +
        '.ytp-menuitem[aria-label*="Copy"],' +
        '.ytp-menuitem[aria-label*="copy"],' +
        '.ytp-menuitem[aria-label*="Share"],' +
        '.ytp-menuitem[aria-label*="share"],' +
        '.ytp-endscreen,' +
        'button[aria-label*="Copy"],' +
        'button[title*="Copy"],' +
        '.ytp-button[aria-label*="Copy"],' +
        'a.ytp-title-link,' +
        'a.ytp-youtube-button,' +
        'button.ytp-share-button-visible,' +
        'button[aria-label*="Share"],' +
        'button[aria-label*="share"],' +
        'button[title*="Share"],' +
        'button[title*="share"],' +
        '[aria-label*="Share"],' +
        '[aria-label*="share"],' +
        '[title*="Share"],' +
        '[title*="share"],' +
        '.ytp-share-button-container,' +
        '.ytp-chrome-bottom .ytp-share-button' +
        ' { display:none !important; visibility:hidden !important; opacity:0 !important; pointer-events:none !important; }' +
        ' * { user-select:none !important; -webkit-user-select:none !important; }';

    // Insert into <body> — youtube-nocookie can strip <head> injections
    if (document.body) {
        document.body.insertBefore(s, document.body.firstChild);
    } else if (document.head) {
        document.head.insertBefore(s, document.head.firstChild);
    }
})();
`;

    webview.executeJavaScript(cssScript).catch(err => {
        console.warn('CSS injection failed:', err);
    });
}

// OPTIMIZED: Slower guardian interval (1 second instead of 500ms)
function startWatermarkGuardian(webview) {
    if (guardianInterval) {
        clearInterval(guardianInterval);
        guardianInterval = null;
    }
    
    guardianInterval = setInterval(() => {
        if (!isWatermarkInjected) return;
        
        webview.executeJavaScript(`
            (function() {
                var wm = document.getElementById('security-watermark');
                var st = document.getElementById('wm-hide-yt');
                return { wm: !!wm, st: !!st };
            })();
        `).then(state => {
            if (!state.wm) {
                console.log('Guardian: watermark missing – re-injecting');
                injectWatermarkIntoWebview(webview);
            }
            if (!state.st) {
                console.log('Guardian: hide-CSS missing – re-injecting');
                injectHidingCSS(webview);
            }
        }).catch(err => {
            if (guardianInterval) {
                clearInterval(guardianInterval);
                guardianInterval = null;
            }
        });
    }, 1000);
}

// UPDATED: Simplified injection function (CSS is already injected)
function injectWatermarkIntoWebview(webview) {
    if (!currentStudent) return;

    const studentInfo = `${currentStudent.first_name} ${currentStudent.last_name || ''} • ${currentStudent.student_email_id}`;

    const script = `
(function() {
    var WATERMARK_ID = 'security-watermark';
    var STYLE_ID     = 'wm-hide-yt';
    var TEXT         = '${studentInfo.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}';

    function getParent() {
        var fsElement = document.fullscreenElement || 
                       document.webkitFullscreenElement || 
                       document.mozFullScreenElement;
        
        if (fsElement) {
            return fsElement.querySelector('.html5-video-player') || 
                   fsElement.querySelector('.ytp-player-container') || 
                   fsElement;
        }
        
        return document.querySelector('.ytp-player-container') ||
               document.querySelector('.html5-video-player') ||
               document.querySelector('#player') ||
               document.body;
    }

    // Ensure CSS is still there (backup check)
    function ensureStyle() {
        var existing = document.getElementById(STYLE_ID);
        if (existing) return;
        
        var s = document.createElement('style');
        s.id = STYLE_ID;
        s.textContent =
            '.ytp-youtube-button,' +
            '.ytp-watermark,' +
            '.ytp-title-link,' +
            '.ytp-title,' +
            '.ytp-share-button,' +
            '.ytp-watch-later-button,' +
            '.ytp-cards-button,' +
            '.ytp-cards-teaser,' +
            '.ytp-ce-element,' +
            '.ytp-endscreen-content,' +
            '.ytp-pause-overlay,' +
            '.ytp-chrome-top-buttons,' +
            '.ytp-chrome-top,' +
            '.ytp-contextmenu,' +
            '.ytp-copylink-button,' +
            '.ytp-copylink-icon,' +
            '.ytp-impression-link,' +
            '.ytp-title-text,' +
            '.ytp-title-channel,' +
            '.ytp-watch-on-youtube,' +
            '.ytp-share-button-group,' +
            '.ytp-expand-btn,' +
            '.ytp-player-info-panel,' +
            '[data-tooltip-text*="Watch on YouTube"],' +
            '[aria-label*="Watch on YouTube"],' +
            '[aria-label*="watch on YouTube"],' +
            '[title*="Watch on YouTube"],' +
            '[title*="Copy link"],' +
            '[aria-label*="Copy link"],' +
            '.ytp-menuitem[aria-label*="Copy"],' +
            '.ytp-menuitem[aria-label*="copy"],' +
            '.ytp-menuitem[aria-label*="Share"],' +
            '.ytp-menuitem[aria-label*="share"],' +
            '.ytp-endscreen,' +
            'button[aria-label*="Copy"],' +
            'button[title*="Copy"],' +
            '.ytp-button[aria-label*="Copy"],' +
            'a.ytp-title-link,' +
            'a.ytp-youtube-button,' +
            'button.ytp-share-button-visible,' +
            'button[aria-label*="Share"],' +
            'button[aria-label*="share"],' +
            'button[title*="Share"],' +
            'button[title*="share"],' +
            '[aria-label*="Share"],' +
            '[aria-label*="share"],' +
            '[title*="Share"],' +
            '[title*="share"],' +
            '.ytp-share-button-container,' +
            '.ytp-chrome-bottom .ytp-share-button' +
            ' { display:none !important; visibility:hidden !important; opacity:0 !important; pointer-events:none !important; }' +
            ' * { user-select:none !important; -webkit-user-select:none !important; }';
        document.head.insertBefore(s, document.head.firstChild);
    }

    function ensureWatermark() {
        var oldWm = document.getElementById(WATERMARK_ID);
        if (oldWm) {
            oldWm.remove();
        }

        var container = document.createElement('div');
        container.id = WATERMARK_ID;
        container.setAttribute('data-watermark', 'true');
        
        container.style.cssText =
            'position: fixed !important;' +
            'top: 0 !important;' +
            'left: 0 !important;' +
            'width: 100% !important;' +
            'height: 100% !important;' +
            'pointer-events: none !important;' +
            'z-index: 2147483647 !important;' +
            'user-select: none !important;' +
            '-webkit-user-select: none !important;';

        var positions = [
            { x: 45, y: 10 },
            { x: 10, y: 45 }
        ];

        positions.forEach(function(pos) {
            var mark = document.createElement('div');
            mark.className = 'wm-stamp';
            mark.textContent = TEXT;
            mark.style.cssText =
                'position: absolute !important;' +
                'left: ' + pos.x + '% !important;' +
                'top: ' + pos.y + '% !important;' +
                'color: rgba(255,255,255,0.15) !important;' +
                'font-size: 17px !important;' +
                'font-family: Courier New, monospace !important;' +
                'font-weight: bold !important;' +
                'white-space: nowrap !important;' +
                'transform: rotate(-30deg) !important;' +
                'pointer-events: none !important;' +
                'z-index: 2147483647 !important;' +
                'text-shadow: 2px 2px 6px rgba(0,0,0,0.85) !important;' +
                'transition: left 4s ease-in-out, top 4s ease-in-out !important;';
            container.appendChild(mark);
        });

        var parent = getParent();
        parent.appendChild(container);
        
        console.log('Watermark injected');
    }
    
    if (!window.__wmShortcutsBlocked) {
        window.__wmShortcutsBlocked = true;
        document.addEventListener('contextmenu', function(e) { 
            e.preventDefault(); 
            return false; 
        }, true);
        document.addEventListener('keydown', function(e) {
            if (e.keyCode === 123 ||
                (e.ctrlKey && e.shiftKey && (e.keyCode === 73 || e.keyCode === 74)) ||
                (e.ctrlKey && e.keyCode === 85)) {
                e.preventDefault();
                return false;
            }
        }, true);
    }

    ensureStyle();
    ensureWatermark();

    // Animate stamps every 4 seconds
    if (!window.__wmAnimInterval) {
        window.__wmAnimInterval = setInterval(function() {
            var wm = document.getElementById(WATERMARK_ID);
            if (!wm) return;
            var stamps = wm.querySelectorAll('.wm-stamp');
            stamps.forEach(function(stamp) {
                var newX = Math.floor(Math.random() * 60);
                var newY = Math.floor(Math.random() * 85);
                stamp.style.left = newX + '%';
                stamp.style.top  = newY + '%';
            });
        }, 4000);
    }
    
    // Mutation observer with throttling
    if (!window.__wmObserver) {
        var lastCheck = 0;
        var observer = new MutationObserver(function(mutations) {
            var now = Date.now();
            if (now - lastCheck < 1000) return;
            lastCheck = now;
            
            if (!document.getElementById(WATERMARK_ID)) {
                console.log('Watermark removed - re-injecting');
                ensureWatermark();
            }
            if (!document.getElementById(STYLE_ID)) {
                ensureStyle();
            }
        });
        
        observer.observe(document.body, {
            childList: true,
            subtree: true
        });
        
        window.__wmObserver = observer;
    }
})();
`;

    webview.executeJavaScript(script).catch(err => {
        console.warn('Watermark injection failed:', err);
    });
}

function updatePlaylist(currentIndex) {
    const playlistEl = document.getElementById('playlistVideos');
    playlistEl.innerHTML = '';
    
    document.getElementById('playlistCount').textContent = `${currentVideos.length} video${currentVideos.length !== 1 ? 's' : ''}`;
    
    currentVideos.forEach((video, index) => {
        const item = document.createElement('div');
        item.className = 'playlist-item' + (index === currentIndex ? ' active' : '');
        item.onclick = () => playVideo(video, index);
        
        item.innerHTML = `
            <div class="playlist-item-number">${index + 1}</div>
            <div class="playlist-item-info">
                <div class="playlist-item-title">${video.title || video.name}</div>
                <div class="playlist-item-meta">Lecture ${index + 1}</div>
            </div>
            ${index === currentIndex ? '<div class="playlist-item-playing">▶️</div>' : ''}
        `;
        
        playlistEl.appendChild(item);
    });
}

function backToVideos() {
    document.getElementById('videoPlayer').classList.add('hidden');
    document.getElementById('videoLoadingScreen').classList.add('hidden');
    document.getElementById('videoListScreen').classList.remove('hidden');
    
    // Hide dots button
    const dotBtn = document.getElementById('tam-dots-btn');
    if (dotBtn) dotBtn.classList.remove('visible');

    _removeWebviewListeners();

    if (guardianInterval) {
        clearInterval(guardianInterval);
        guardianInterval = null;
    }
    
    isWatermarkInjected = false;

    const webview = document.getElementById('videoFrame');
    webview.src = 'about:blank';
    
    removeFloatingWatermark();
}

function backToCourses() {
    document.getElementById('videoListScreen').classList.add('hidden');
    document.getElementById('courseList').classList.remove('hidden');
    
    // Hide live class button
    const liveBtn = document.getElementById('liveClassBtn');
    if (liveBtn) liveBtn.classList.add('hidden');
    currentLiveClassLink = '';
    
    currentCourse = null;
    currentVideos = [];
}

function logout() {
    alert('Logout is disabled. This is a one-time access session.');
    return;
}

let watermarkInterval = null;

function addFloatingWatermark() {
    removeFloatingWatermark();
    
    if (!currentStudent) return;
    
    const watermark = document.createElement('div');
    watermark.id = 'floatingWatermark';
    watermark.style.cssText = `
        position: fixed !important;
        top: 0 !important;
        left: 0 !important;
        width: 100vw !important;
        height: 100vh !important;
        pointer-events: none !important;
        z-index: 2147483647 !important;
        user-select: none !important;
    `;
    
    watermark.setAttribute('data-fullscreen-watermark', 'true');
    
    const studentInfo = `${currentStudent.first_name} ${currentStudent.last_name || ''} • ${currentStudent.student_email_id}`;
    
    const seedPositions = [

    ];

    seedPositions.forEach((pos) => {
        const mark = document.createElement('div');
        mark.className = 'watermark-text';
        mark.style.cssText = `
            position: absolute !important;
            left: ${pos.x}% !important;
            top: ${pos.y}% !important;
            color: rgba(255, 255, 255, 0.15) !important;
            font-size: 18px !important;
            font-family: 'Courier New', monospace !important;
            font-weight: bold !important;
            white-space: nowrap !important;
            pointer-events: none !important;
            z-index: 2147483647 !important;
            text-shadow: 2px 2px 6px rgba(0,0,0,0.85) !important;
            transition: left 4s ease-in-out, top 4s ease-in-out !important;
        `;
        mark.textContent = studentInfo;
        watermark.appendChild(mark);
    });
    
    document.body.appendChild(watermark);

    watermarkInterval = setInterval(() => {
        const marks = document.querySelectorAll('#floatingWatermark .watermark-text');
        marks.forEach((mark) => {
            const newX = Math.floor(Math.random() * 60);
            const newY = Math.floor(Math.random() * 85);
            mark.style.left = newX + '%';
            mark.style.top  = newY + '%';
        });
    }, 4000);
    
    document.addEventListener('fullscreenchange',       ensureWatermarkVisible);
    document.addEventListener('webkitfullscreenchange', ensureWatermarkVisible);
    document.addEventListener('mozfullscreenchange',    ensureWatermarkVisible);
    document.addEventListener('MSFullscreenChange',     ensureWatermarkVisible);
}

function ensureWatermarkVisible() {
    const watermark = document.getElementById('floatingWatermark');
    if (watermark) {
        watermark.style.position = 'fixed';
        watermark.style.zIndex   = '2147483647';
        watermark.style.width    = '100vw';
        watermark.style.height   = '100vh';
        watermark.style.top      = '0';
        watermark.style.left     = '0';
        watermark.style.pointerEvents = 'none';
    }
}

function removeFloatingWatermark() {
    const existing = document.getElementById('floatingWatermark');
    if (existing) existing.remove();
    if (watermarkInterval) {
        clearInterval(watermarkInterval);
        watermarkInterval = null;
    }
    
    document.removeEventListener('fullscreenchange',       ensureWatermarkVisible);
    document.removeEventListener('webkitfullscreenchange', ensureWatermarkVisible);
    document.removeEventListener('mozfullscreenchange',    ensureWatermarkVisible);
    document.removeEventListener('MSFullscreenChange',     ensureWatermarkVisible);
}

function addWatermarkOverlay()    { addFloatingWatermark(); }
function removeWatermarkOverlay() { removeFloatingWatermark(); }

// ── LIVE CLASS FUNCTIONALITY ─────────────────────────────────────────────────
let currentLiveClassLink = '';

function isLiveClassLink(url) {
    if (!url || typeof url !== 'string') return false;
    const urlLower = url.toLowerCase();
    return urlLower.includes('zoom.us') || 
           urlLower.includes('meet.google.com') || 
           urlLower.includes('zoom.com') || 
           urlLower.includes('youtube.com') || 
           urlLower.includes('teams.microsoft.com');
}

function checkAndShowLiveClassButton(link) {
    const btn = document.getElementById('liveClassBtn');
    if (!btn) return;
    
    if (isLiveClassLink(link)) {
        currentLiveClassLink = link;
        btn.classList.remove('hidden');
    } else {
        currentLiveClassLink = '';
        btn.classList.add('hidden');
    }
}

function showLiveClassModal() {
    if (!currentLiveClassLink) return;
    
    const modal = document.getElementById('liveClassModal');
    const input = document.getElementById('liveClassLink');
    
    if (modal && input) {
        input.value = currentLiveClassLink;
        modal.classList.remove('hidden');
    }
}

function closeLiveClassModal() {
    const modal = document.getElementById('liveClassModal');
    if (modal) {
        modal.classList.add('hidden');
    }
}

function copyLiveClassLink() {
    const input = document.getElementById('liveClassLink');
    const btnText = document.getElementById('copyBtnText');
    
    if (!input) return;
    
    input.select();
    document.execCommand('copy');
    
    if (btnText) {
        const originalText = btnText.textContent;
        btnText.textContent = '✓ Copied!';
        setTimeout(() => {
            btnText.textContent = originalText;
        }, 2000);
    }
}

function openLiveClassLink() {
    if (!currentLiveClassLink) return;
    
    // Open in external browser via Electron
    require('electron').shell.openExternal(currentLiveClassLink);
    
    // Close modal
    closeLiveClassModal();
}

// ── RECORDING DETECTION ──────────────────────────────────────────────────────
ipcRenderer.on('recording-detected', () => {
    const webview = document.getElementById('videoFrame');
    if (webview && webview.src && webview.src.includes('youtube')) {
        webview.executeJavaScript(`
            const video = document.querySelector('video');
            if (video) { video.pause(); }
        `);
    }
});

// ═══════════════════════════════════════════════════════════════════
//  AUTO-UPDATE HANDLING
// ═══════════════════════════════════════════════════════════════════

let updateNotification = null;
let downloadProgress = null;

// Create update notification element
function createUpdateNotification(message, type = 'info') {
    // Remove existing notification
    if (updateNotification && updateNotification.parentNode) {
        updateNotification.parentNode.removeChild(updateNotification);
    }

    updateNotification = document.createElement('div');
    updateNotification.className = `update-notification update-${type}`;
    updateNotification.innerHTML = `
        <div class="update-content">
            <div class="update-icon">${type === 'success' ? '✓' : type === 'error' ? '✕' : '🔄'}</div>
            <div class="update-message">${message}</div>
        </div>
    `;
    document.body.appendChild(updateNotification);

    // Auto-hide after 5 seconds for info messages
    if (type === 'info') {
        setTimeout(() => {
            if (updateNotification && updateNotification.parentNode) {
                updateNotification.classList.add('hiding');
                setTimeout(() => {
                    if (updateNotification && updateNotification.parentNode) {
                        updateNotification.parentNode.removeChild(updateNotification);
                    }
                }, 300);
            }
        }, 5000);
    }
}

// Update available
ipcRenderer.on('update-available', (event, info) => {
    console.log('Update available:', info.version);
    
    const notification = document.createElement('div');
    notification.className = 'update-notification update-available';
    notification.innerHTML = `
        <div class="update-content">
            <div class="update-icon">📦</div>
            <div class="update-message">
                <strong>Update Available!</strong>
                <p>Version ${info.version} is ready to download</p>
            </div>
            <div class="update-actions">
                <button class="update-btn download-btn" onclick="downloadUpdate()">Download</button>
                <button class="update-btn dismiss-btn" onclick="dismissUpdate()">Later</button>
            </div>
        </div>
    `;
    
    // Remove existing
    if (updateNotification && updateNotification.parentNode) {
        updateNotification.parentNode.removeChild(updateNotification);
    }
    
    updateNotification = notification;
    document.body.appendChild(updateNotification);
});

// No update available
ipcRenderer.on('update-not-available', () => {
    console.log('App is up to date');
});

// Download progress
ipcRenderer.on('download-progress', (event, progress) => {
    console.log('Download progress:', progress.percent + '%');
    
    if (!downloadProgress) {
        const notification = document.createElement('div');
        notification.className = 'update-notification update-downloading';
        notification.innerHTML = `
            <div class="update-content">
                <div class="update-icon">⬇️</div>
                <div class="update-message">
                    <strong>Downloading Update...</strong>
                    <div class="progress-bar">
                        <div class="progress-fill" id="updateProgressFill"></div>
                    </div>
                    <div class="progress-text" id="updateProgressText">0%</div>
                </div>
            </div>
        `;
        
        if (updateNotification && updateNotification.parentNode) {
            updateNotification.parentNode.removeChild(updateNotification);
        }
        
        downloadProgress = notification;
        updateNotification = notification;
        document.body.appendChild(notification);
    }
    
    const fill = document.getElementById('updateProgressFill');
    const text = document.getElementById('updateProgressText');
    if (fill) fill.style.width = progress.percent + '%';
    if (text) text.textContent = progress.percent + '%';
});

// Update downloaded
ipcRenderer.on('update-downloaded', (event, info) => {
    console.log('Update downloaded:', info.version);
    
    const notification = document.createElement('div');
    notification.className = 'update-notification update-ready';
    notification.innerHTML = `
        <div class="update-content">
            <div class="update-icon">✓</div>
            <div class="update-message">
                <strong>Update Ready!</strong>
                <p>Version ${info.version} has been downloaded</p>
            </div>
            <div class="update-actions">
                <button class="update-btn install-btn" onclick="installUpdate()">Restart & Install</button>
                <button class="update-btn dismiss-btn" onclick="dismissUpdate()">Install on Exit</button>
            </div>
        </div>
    `;
    
    if (updateNotification && updateNotification.parentNode) {
        updateNotification.parentNode.removeChild(updateNotification);
    }
    
    downloadProgress = null;
    updateNotification = notification;
    document.body.appendChild(updateNotification);
});

// Update error
ipcRenderer.on('update-error', (event, error) => {
    console.error('Update error:', error.message);
    createUpdateNotification('Failed to check for updates: ' + error.message, 'error');
});

// Update action functions
function downloadUpdate() {
    ipcRenderer.send('download-update');
    if (updateNotification && updateNotification.parentNode) {
        updateNotification.parentNode.removeChild(updateNotification);
    }
}

function installUpdate() {
    ipcRenderer.send('install-update');
}

function dismissUpdate() {
    if (updateNotification && updateNotification.parentNode) {
        updateNotification.classList.add('hiding');
        setTimeout(() => {
            if (updateNotification && updateNotification.parentNode) {
                updateNotification.parentNode.removeChild(updateNotification);
            }
            updateNotification = null;
            downloadProgress = null;
        }, 300);
    }
}

// Manual update check (optional - you can add a button for this)
function checkForUpdates() {
    ipcRenderer.send('check-for-updates');
    createUpdateNotification('Checking for updates...', 'info');
}