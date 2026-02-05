const { app, BrowserWindow, Menu, shell, session, desktopCapturer, ipcMain } = require('electron');
const path = require('path');
const fs = require('fs');

let mainWindow;
const credentialsPath = path.join(app.getPath('userData'), 'credentials.json');

app.setName('LMS by HM Technologies');
const APP_ID = 'com.genex.studentvideoplayer';
const REFERER = `https://${APP_ID}`;
const isProduction = process.env.NODE_ENV === 'production' || !process.defaultApp;

function createWindow() {
    const videoSession = session.fromPartition('persist:videoplayer');

    videoSession.webRequest.onBeforeSendHeaders((details, callback) => {
        if (details.url.includes('youtube.com') || details.url.includes('googlevideo.com') || details.url.includes('googleapis.com')) {
            details.requestHeaders['User-Agent'] = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
            details.requestHeaders['Referer'] = REFERER;
            delete details.requestHeaders['Origin'];
            delete details.requestHeaders['origin'];
        }
        callback({ requestHeaders: details.requestHeaders });
    });

    videoSession.webRequest.onHeadersReceived((details, callback) => {
        callback({ responseHeaders: details.responseHeaders });
    });

    const { screen } = require('electron');
    const primaryDisplay = screen.getPrimaryDisplay();
    const { width, height } = primaryDisplay.workAreaSize;

    mainWindow = new BrowserWindow({
        width: width,
        height: height,
        minWidth: 800,
        minHeight: 600,
        x: 0,
        y: 0,
        icon: path.join(__dirname, 'assets/icon.png'),
        webPreferences: {
            nodeIntegration: true,
            contextIsolation: false,
            webviewTag: true,
            allowRunningInsecureContent: false,
            webSecurity: false,
            partition: 'persist:videoplayer',
            devTools: false, // ALWAYS DISABLED
            offscreen: false,
            enableWebSQL: false
        },
        backgroundColor: '#667eea',
        show: false,
        autoHideMenuBar: true,
        fullscreen: false,
        kiosk: false,
        alwaysOnTop: false,
        skipTaskbar: false,
        contentProtection: true,
        roundedCorners: false,
        transparent: false,
        frame: true,
        titleBarStyle: 'default',
        thickFrame: true
    });

    // CRITICAL: Remove application menu (disables Alt menu)
    Menu.setApplicationMenu(null);

    mainWindow.setFullScreenable(true);

    // Disable right-click ALWAYS
    mainWindow.webContents.on('context-menu', (e) => {
        e.preventDefault();
    });

    // Prevent DevTools ALWAYS
    mainWindow.webContents.on('devtools-opened', () => {
        mainWindow.webContents.closeDevTools();
    });

    mainWindow.loadFile('index.html');

    mainWindow.webContents.setWindowOpenHandler(({ url }) => {
        console.log('Blocked external link:', url);
        return { action: 'deny' };
    });

    mainWindow.once('ready-to-show', () => {
        mainWindow.show();
        mainWindow.setContentProtection(true);
        if (process.platform === 'win32') {
            startScreenCaptureMonitoring();
        }
    });

    mainWindow.webContents.on('did-attach-webview', (event, webContents) => {
        webContents.on('devtools-opened', () => {
            webContents.closeDevTools();
        });
        
        webContents.on('context-menu', (e) => {
            e.preventDefault();
        });

        webContents.setWindowOpenHandler(({ frameName }) => {
            if (frameName === 'youtube-fullscreen') {
                return { action: 'allow' };
            }
            return { action: 'deny' };
        });

        webContents.session.webRequest.onBeforeSendHeaders((details, callback) => {
            if (details.url.includes('youtube.com') || details.url.includes('googlevideo.com') || details.url.includes('googleapis.com')) {
                details.requestHeaders['User-Agent'] = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
                details.requestHeaders['Referer'] = REFERER;
                delete details.requestHeaders['Origin'];
                delete details.requestHeaders['origin'];
            }
            callback({ cancel: false, requestHeaders: details.requestHeaders });
        });

        webContents.session.webRequest.onHeadersReceived((details, callback) => {
            callback({ responseHeaders: details.responseHeaders });
        });

        webContents.session.setPermissionRequestHandler((webContents, permission, callback) => {
            const allowedPermissions = ['fullscreen', 'audioCapture', 'videoCapture'];
            callback(allowedPermissions.includes(permission));
        });

        webContents.on('will-navigate', (event, url) => {
            if (url.includes('youtube.com') && !url.includes('/embed/')) {
                event.preventDefault();
                console.log('Blocked navigation to:', url);
            }
        });
    });

    // BLOCK ALL DEVTOOLS SHORTCUTS AND ALT KEY
    mainWindow.webContents.on('before-input-event', (event, input) => {
        // Block F12
        if (input.key === 'F12') {
            event.preventDefault();
            return;
        }
        
        // Block Ctrl+Shift+I
        if (input.control && input.shift && (input.key === 'I' || input.key === 'i')) {
            event.preventDefault();
            return;
        }
        
        // Block Ctrl+Shift+J
        if (input.control && input.shift && (input.key === 'J' || input.key === 'j')) {
            event.preventDefault();
            return;
        }
        
        // Block Ctrl+Shift+C
        if (input.control && input.shift && (input.key === 'C' || input.key === 'c')) {
            event.preventDefault();
            return;
        }
        
        // Block Ctrl+U
        if (input.control && (input.key === 'U' || input.key === 'u')) {
            event.preventDefault();
            return;
        }
        
        // Block Ctrl+S
        if (input.control && (input.key === 'S' || input.key === 's')) {
            event.preventDefault();
            return;
        }
        
        // Block Ctrl+P
        if (input.control && (input.key === 'P' || input.key === 'p')) {
            event.preventDefault();
            return;
        }
        
        // BLOCK Alt key (prevents menu)
        if (input.alt && !input.control && !input.shift && !input.meta) {
            event.preventDefault();
            return;
        }
        
        // Block Alt+F4
        if (input.alt && input.key === 'F4') {
            event.preventDefault();
            return;
        }
    });

    mainWindow.on('closed', () => {
        mainWindow = null;
        if (captureMonitorInterval) {
            clearInterval(captureMonitorInterval);
        }
    });
}

let captureMonitorInterval = null;

function startScreenCaptureMonitoring() {
    captureMonitorInterval = setInterval(async () => {
        try {
            const sources = await desktopCapturer.getSources({ 
                types: ['window', 'screen'],
                thumbnailSize: { width: 1, height: 1 }
            });
            
            const suspiciousApps = [
                'obs', 'streamlabs', 'xsplit', 'bandicam', 'camtasia', 
                'fraps', 'snagit', 'screen recorder', 'capture', 'record',
                'zoom', 'teams', 'discord', 'skype', 'meet', 'webex',
                'snipping', 'screenshot', 'gyazo', 'lightshot', 'greenshot'
            ];
            
            const recordingDetected = sources.some(source => {
                const name = source.name.toLowerCase();
                return suspiciousApps.some(app => name.includes(app));
            });
            
            if (recordingDetected && mainWindow) {
                mainWindow.webContents.send('recording-detected');
            }
        } catch (error) {
            console.error('Error monitoring screen capture:', error);
        }
    }, 3000);
}

app.commandLine.appendSwitch('disable-features', 'OutOfBlinkCors,IsolateOrigins,site-per-process');
app.commandLine.appendSwitch('disable-site-isolation-trials');
app.commandLine.appendSwitch('disable-web-security');
app.commandLine.appendSwitch('enable-features', 'VaapiVideoDecoder');
app.commandLine.appendSwitch('ignore-gpu-blacklist');
app.commandLine.appendSwitch('enable-gpu-rasterization');
app.commandLine.appendSwitch('enable-zero-copy');
app.disableHardwareAcceleration = () => {};

ipcMain.handle('save-credentials', async (event, credentials) => {
    try {
        const encryptedData = {
            email: credentials.email,
            password: Buffer.from(credentials.password).toString('base64'),
            privateKey: Buffer.from(credentials.privateKey).toString('base64'),
            studentData: Buffer.from(credentials.studentData).toString('base64')
        };
        fs.writeFileSync(credentialsPath, JSON.stringify(encryptedData), 'utf8');
        return true;
    } catch (error) {
        console.error('Error saving credentials:', error);
        return false;
    }
});

ipcMain.handle('get-credentials', async (event) => {
    try {
        if (!fs.existsSync(credentialsPath)) {
            return null;
        }
        const encryptedData = JSON.parse(fs.readFileSync(credentialsPath, 'utf8'));
        const credentials = {
            email: encryptedData.email,
            password: Buffer.from(encryptedData.password, 'base64').toString(),
            privateKey: Buffer.from(encryptedData.privateKey, 'base64').toString(),
            studentData: Buffer.from(encryptedData.studentData, 'base64').toString()
        };
        return credentials;
    } catch (error) {
        console.error('Error getting credentials:', error);
        return null;
    }
});

ipcMain.handle('clear-credentials', async (event) => {
    try {
        if (fs.existsSync(credentialsPath)) {
            fs.unlinkSync(credentialsPath);
        }
        return true;
    } catch (error) {
        console.error('Error clearing credentials:', error);
        return false;
    }
});

app.whenReady().then(createWindow);

app.on('window-all-closed', () => {
    app.quit();
});

app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
        createWindow();
    }
});

app.on('before-quit', (event) => {
    if (mainWindow) {
        const { dialog } = require('electron');
        event.preventDefault();
        dialog.showMessageBox(mainWindow, {
            type: 'question',
            buttons: ['Cancel', 'Exit'],
            title: 'Confirm Exit',
            message: 'Are you sure you want to exit?',
            detail: 'Your progress will be saved.'
        }).then(result => {
            if (result.response === 1) {
                app.exit(0);
            }
        });
    }
});

app.on('web-contents-created', (event, contents) => {
    contents.on('will-navigate', (event, navigationUrl) => {
        const parsedUrl = new URL(navigationUrl);
        if (parsedUrl.protocol !== 'file:' && !navigationUrl.includes('youtube.com/embed/')) {
            event.preventDefault();
        }
    });
});