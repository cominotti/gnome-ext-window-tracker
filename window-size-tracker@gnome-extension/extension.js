/**
 * Window Size Tracker - GNOME Shell Extension for GNOME 49
 * 
 * Tracks window sizes when applications are resized or closed,
 * and restores them when the applications are relaunched.
 * Persists across GNOME sessions. Wayland-only.
 * 
 * All logic is contained in this single file.
 */

import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import Meta from 'gi://Meta';
import Shell from 'gi://Shell';

import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';

// =============================================================================
// CONSTANTS
// =============================================================================

const SAVE_DEBOUNCE_MS = 1000;          // Debounce time for saving to disk
const SIZE_CHANGE_DEBOUNCE_MS = 500;    // Debounce time for size change events
const WINDOW_READY_TIMEOUT_MS = 100;    // Time to wait for window to become ready
const WINDOW_READY_MAX_ATTEMPTS = 50;   // Max attempts to wait for window ready
const RESTORE_FALLBACK_DELAY_MS = 50;   // Fallback delay if first-frame doesn't fire
const MIN_WINDOW_SIZE = 50;             // Minimum valid window dimension
const NAUTILUS_LOCATION_WAIT_MS = 100;  // Interval to wait for Nautilus location ID
const NAUTILUS_LOCATION_MAX_ATTEMPTS = 5; // Max attempts (500ms total)

// =============================================================================
// DATA STORAGE CLASS
// =============================================================================

/**
 * Handles persistent storage of window size data to a JSON file.
 * Uses synchronous read at startup for immediate availability,
 * and debounced async writes during operation.
 */
class WindowDataStore {
    constructor(extensionPath, uuid) {
        // Store data in XDG_DATA_HOME for persistence
        this._dataDir = GLib.build_filenamev([
            GLib.get_user_data_dir(),
            'gnome-shell-extensions',
            uuid,
        ]);
        
        this._dataFilePath = GLib.build_filenamev([
            this._dataDir,
            'window-sizes.json',
        ]);
        
        this._data = {};
        this._saveTimeoutId = null;
        this._dirty = false;
        
        // Ensure data directory exists
        GLib.mkdir_with_parents(this._dataDir, 0o755);
        
        // Load existing data synchronously at startup
        this._loadSync();
    }
    
    /**
     * Loads data synchronously from disk.
     * Used at startup to ensure data is immediately available.
     */
    _loadSync() {
        try {
            const file = Gio.File.new_for_path(this._dataFilePath);
            
            if (!file.query_exists(null)) {
                this._data = {};
                return;
            }
            
            const [success, contents] = file.load_contents(null);
            
            if (success) {
                const decoder = new TextDecoder('utf-8');
                const jsonStr = decoder.decode(contents);
                this._data = JSON.parse(jsonStr);
                
                // Validate data structure
                if (typeof this._data !== 'object' || this._data === null) {
                    console.warn('[WindowSizeTracker] Invalid data format, resetting');
                    this._data = {};
                } else {
                    const entryCount = Object.keys(this._data).length;
                    console.log(`[WindowSizeTracker] STATE LOADED FROM DISK: ${entryCount} entries from ${this._dataFilePath}`);
                }
            }
        } catch (e) {
            console.error(`[WindowSizeTracker] Error loading data: ${e.message}`);
            this._data = {};
        }
    }
    
    /**
     * Saves data asynchronously to disk.
     * Called after debounce period.
     */
    async _saveAsync() {
        try {
            const file = Gio.File.new_for_path(this._dataFilePath);
            const jsonStr = JSON.stringify(this._data, null, 2);
            const bytes = new TextEncoder().encode(jsonStr);
            
            // Use replace_contents for atomic write
            await new Promise((resolve, reject) => {
                file.replace_contents_async(
                    bytes,
                    null,  // etag
                    false, // make_backup
                    Gio.FileCreateFlags.REPLACE_DESTINATION,
                    null,  // cancellable
                    (source, result) => {
                        try {
                            source.replace_contents_finish(result);
                            resolve();
                        } catch (e) {
                            reject(e);
                        }
                    }
                );
            });
            
            console.log(`[WindowSizeTracker] STATE SAVED TO DISK: ${this._dataFilePath}`);
            
            this._dirty = false;
        } catch (e) {
            console.error(`[WindowSizeTracker] Error saving data: ${e.message}`);
        }
    }
    
    /**
     * Schedules a debounced save operation.
     */
    _scheduleSave() {
        this._dirty = true;
        
        // Clear existing timeout
        if (this._saveTimeoutId !== null) {
            GLib.Source.remove(this._saveTimeoutId);
            this._saveTimeoutId = null;
        }
        
        // Schedule new save
        this._saveTimeoutId = GLib.timeout_add(
            GLib.PRIORITY_DEFAULT,
            SAVE_DEBOUNCE_MS,
            () => {
                this._saveTimeoutId = null;
                this._saveAsync().catch(e => {
                    console.error(`[WindowSizeTracker] Save failed: ${e.message}`);
                });
                return GLib.SOURCE_REMOVE;
            }
        );
    }
    
    /**
     * Gets the stored size data for a window identifier.
     * @param {string} windowId - The window identifier (wm_class based)
     * @returns {object|null} Size data {width, height} or null if not found
     */
    get(windowId) {
        return this._data[windowId] || null;
    }
    
    /**
     * Sets the size data for a window identifier.
     * @param {string} windowId - The window identifier
     * @param {number} width - Window width
     * @param {number} height - Window height
     */
    set(windowId, width, height) {
        // Only save if values are reasonable
        if (width < MIN_WINDOW_SIZE || height < MIN_WINDOW_SIZE) {
            return;
        }
        
        const existing = this._data[windowId];
        
        // Only save if changed
        if (existing && existing.width === width && existing.height === height) {
            return;
        }
        
            this._data[windowId] = {
                width,
                height,
                lastUpdated: Date.now(),
            };
            
            console.log(`[WindowSizeTracker] STATE SAVED: "${windowId}" -> ${width}x${height}`);
            
            this._scheduleSave();
        }
    
    /**
     * Forces an immediate save (used during disable).
     */
    saveImmediately() {
        if (this._saveTimeoutId !== null) {
            GLib.Source.remove(this._saveTimeoutId);
            this._saveTimeoutId = null;
        }
        
        if (this._dirty) {
            // Synchronous save for disable
            try {
                const file = Gio.File.new_for_path(this._dataFilePath);
                const jsonStr = JSON.stringify(this._data, null, 2);
                const bytes = new TextEncoder().encode(jsonStr);
                file.replace_contents(
                    bytes,
                    null,
                    false,
                    Gio.FileCreateFlags.REPLACE_DESTINATION,
                    null
                );
                this._dirty = false;
            } catch (e) {
                console.error(`[WindowSizeTracker] Error in immediate save: ${e.message}`);
            }
        }
    }
    
    /**
     * Cleans up resources.
     */
    destroy() {
        this.saveImmediately();
        
        if (this._saveTimeoutId !== null) {
            GLib.Source.remove(this._saveTimeoutId);
            this._saveTimeoutId = null;
        }
    }
}

// =============================================================================
// WINDOW TRACKER CLASS
// =============================================================================

/**
 * Tracks window size changes and manages window size restoration.
 */
class WindowSizeManager {
    constructor(dataStore) {
        this._dataStore = dataStore;
        
        // Signal connections on global.display
        this._displaySignals = [];
        
        // Signal connections per window: Map<Meta.Window, number[]>
        this._windowSignals = new Map();
        
        // Windows pending size restoration: Map<Meta.Window, {timeoutId?, signalId?}>
        this._pendingRestoration = new Map();
        
        // Set of window IDs that have been restored in this session
        // to avoid multiple restoration attempts
        this._restoredWindows = new Set();
        
        // Debounce timers for size change events: Map<Meta.Window, timeoutId>
        this._sizeChangeTimers = new Map();
        
        // Windows pending identification (waiting for stable ID): Map<Meta.Window, timeoutId>
        this._pendingIdentification = new Map();
    }
    
    /**
     * Starts tracking windows.
     */
    enable() {
        // Connect to display signals for new windows
        this._connectDisplaySignal('window-created', this._onWindowCreated.bind(this));
        
        // Connect to grab-op-end to detect resize completion
        this._connectDisplaySignal('grab-op-end', this._onGrabOpEnd.bind(this));
        
        // Track all existing windows
        this._trackExistingWindows();
    }
    
    /**
     * Stops tracking and cleans up all resources.
     */
    disable() {
        // Clear all pending identification timers
        for (const [window, timeoutId] of this._pendingIdentification) {
            GLib.Source.remove(timeoutId);
        }
        this._pendingIdentification.clear();
        
        // Clear all pending restorations (may have timeoutId and/or signalId)
        for (const [window, pending] of this._pendingRestoration) {
            if (pending.timeoutId) {
                GLib.Source.remove(pending.timeoutId);
            }
            if (pending.signalId) {
                try {
                    const actor = window.get_compositor_private();
                    if (actor)
                        actor.disconnect(pending.signalId);
                } catch (e) {
                    // Actor may be gone
                }
            }
        }
        this._pendingRestoration.clear();
        
        // Clear all size change timers
        for (const [window, timeoutId] of this._sizeChangeTimers) {
            GLib.Source.remove(timeoutId);
        }
        this._sizeChangeTimers.clear();
        
        // Disconnect all window signals
        for (const [window, signals] of this._windowSignals) {
            for (const signalId of signals) {
                try {
                    window.disconnect(signalId);
                } catch (e) {
                    // Window may already be destroyed
                }
            }
        }
        this._windowSignals.clear();
        
        // Disconnect display signals
        for (const {signalId} of this._displaySignals) {
            try {
                global.display.disconnect(signalId);
            } catch (e) {
                // Ignore
            }
        }
        this._displaySignals = [];
        
        this._restoredWindows.clear();
    }
    
    /**
     * Connects a signal to global.display and tracks it.
     */
    _connectDisplaySignal(signalName, callback) {
        const signalId = global.display.connect(signalName, callback);
        this._displaySignals.push({signalName, signalId});
    }
    
    /**
     * Tracks all currently existing windows.
     */
    _trackExistingWindows() {
        const windowActors = global.compositor.get_window_actors();
        
        for (const actor of windowActors) {
            const window = actor.meta_window;
            if (this._isTrackableWindow(window)) {
                this._trackWindow(window);
            }
        }
    }
    
    /**
     * Determines if a window should be tracked.
     * Only tracks normal application windows that can be identified.
     */
    _isTrackableWindow(window) {
        if (!window)
            return false;
        
        // Only track normal windows (not dialogs, menus, etc.)
        if (window.get_window_type() !== Meta.WindowType.NORMAL)
            return false;
        
        // Skip windows marked as skip-taskbar (usually utility windows)
        if (window.is_skip_taskbar())
            return false;
        
        // Must have either a desktop app ID or WM_CLASS to be identifiable
        const tracker = Shell.WindowTracker.get_default();
        const app = tracker.get_window_app(window);
        
        if (app && app.get_id())
            return true;
        
        if (window.get_wm_class())
            return true;
        
        return false;
    }
    
    /**
     * Gets a unique identifier for a window based on its application.
     * Prioritizes the .desktop app ID (more reliable on Wayland) over WM_CLASS.
     */
    _getWindowId(window) {
        // Primary: Use Shell.WindowTracker to get the .desktop app ID
        // This is more reliable on Wayland as it's the canonical identifier
        const tracker = Shell.WindowTracker.get_default();
        const app = tracker.get_window_app(window);
        
        if (app) {
            const appId = app.get_id();
            if (appId) {
                // Reject dynamic/transient window IDs like "window:3.desktop"
                // These are assigned to transient windows without proper app association
                if (appId.startsWith('window:')) {
                    // Fall through to WM_CLASS check
                } else {
                    // Remove .desktop suffix and normalize
                    return appId.replace(/\.desktop$/, '').toLowerCase();
                }
            }
        }
        
        // Fallback: Use WM_CLASS for apps without proper .desktop files
        // (e.g., some X11 apps running under XWayland)
        const wmClass = window.get_wm_class();
        if (wmClass) {
            return wmClass.toLowerCase();
        }
        
        return null;
    }

    /**
     * Checks if a window belongs to Nautilus file manager.
     * Used to apply special handling for location-based window IDs.
     */
    _isNautilusWindow(window) {
        const tracker = Shell.WindowTracker.get_default();
        const app = tracker.get_window_app(window);
        if (!app) return false;
        const appId = app.get_id();
        return appId && appId.toLowerCase().includes('nautilus');
    }

    /**
     * Checks if a window ID is location-based (GNOME dynamic association).
     * These IDs are created for Nautilus windows showing specific locations.
     */
    _isLocationBasedId(windowId) {
        if (!windowId) return false;
        return windowId.startsWith('location:') ||
               windowId.startsWith('mountable-volume:') ||
               windowId.startsWith('network:');
    }

    /**
     * Starts tracking a window for size changes.
     */
    _trackWindow(window) {
        // Don't track if already tracking
        if (this._windowSignals.has(window))
            return;
        
        const signals = [];
        
        // Track size changes
        signals.push(
            window.connect('size-changed', () => this._onSizeChanged(window))
        );
        
        // Track when window is about to be destroyed
        signals.push(
            window.connect('unmanaging', () => this._onWindowUnmanaging(window))
        );
        
        this._windowSignals.set(window, signals);
    }
    
    /**
     * Stops tracking a window.
     */
    _untrackWindow(window) {
        const signals = this._windowSignals.get(window);
        
        if (signals) {
            for (const signalId of signals) {
                try {
                    window.disconnect(signalId);
                } catch (e) {
                    // Ignore - window may be destroyed
                }
            }
            this._windowSignals.delete(window);
        }
        
        // Clear any pending size change timer
        const timer = this._sizeChangeTimers.get(window);
        if (timer) {
            GLib.Source.remove(timer);
            this._sizeChangeTimers.delete(window);
        }
        
        // Clear pending restoration (may have timeoutId and/or signalId)
        const pending = this._pendingRestoration.get(window);
        if (pending) {
            if (pending.timeoutId) {
                GLib.Source.remove(pending.timeoutId);
            }
            if (pending.signalId) {
                try {
                    const actor = window.get_compositor_private();
                    if (actor)
                        actor.disconnect(pending.signalId);
                } catch (e) {
                    // Actor may be gone
                }
            }
            this._pendingRestoration.delete(window);
        }
    }
    
    /**
     * Handles new window creation.
     */
    _onWindowCreated(display, window) {
        // Basic window type checks first
        if (!window)
            return;
        
        // Only track normal windows (not dialogs, menus, etc.)
        if (window.get_window_type() !== Meta.WindowType.NORMAL)
            return;
        
        // Skip windows marked as skip-taskbar (usually utility windows)
        if (window.is_skip_taskbar())
            return;
        
        // Try to get a stable window ID
        const windowId = this._getWindowId(window);
        
        if (windowId) {
            // We have a stable ID - proceed normally
            console.log(`[WindowSizeTracker] WINDOW IDENTIFIED: "${windowId}" (type: ${window.get_window_type()}, wm_class: ${window.get_wm_class()})`);
            this._trackWindow(window);
            this._scheduleRestoration(window);
        } else {
            // No stable ID yet - schedule periodic checks until we get one
            console.log(`[WindowSizeTracker] WINDOW CREATED: awaiting stable ID (type: ${window.get_window_type()}, wm_class: ${window.get_wm_class()})`);
            this._scheduleWindowCheck(window);
        }
    }
    
    /**
     * Schedules periodic checks for a window that doesn't have a stable ID yet.
     * Waits for the app ID or WM_CLASS to become available.
     */
    _scheduleWindowCheck(window, attempt = 0) {
        if (attempt >= WINDOW_READY_MAX_ATTEMPTS) {
            console.log(`[WindowSizeTracker] WINDOW IDENTIFICATION FAILED: gave up after ${attempt} attempts`);
            this._pendingIdentification.delete(window);
            return;
        }
        
        // Clear any existing timer for this window
        const existingTimer = this._pendingIdentification.get(window);
        if (existingTimer) {
            GLib.Source.remove(existingTimer);
        }
        
        const timeoutId = GLib.timeout_add(
            GLib.PRIORITY_DEFAULT,
            WINDOW_READY_TIMEOUT_MS,
            () => {
                this._pendingIdentification.delete(window);
                
                // Check if window is still valid
                try {
                    if (!window.get_compositor_private())
                        return GLib.SOURCE_REMOVE;
                } catch (e) {
                    return GLib.SOURCE_REMOVE;
                }
                
                // Try to get stable ID now
                const windowId = this._getWindowId(window);
                
                if (windowId) {
                    console.log(`[WindowSizeTracker] WINDOW IDENTIFIED (delayed, attempt ${attempt + 1}): "${windowId}" (wm_class: ${window.get_wm_class()})`);
                    this._trackWindow(window);
                    this._scheduleRestoration(window);
                } else {
                    // Still no ID - try again
                    this._scheduleWindowCheck(window, attempt + 1);
                }
                
                return GLib.SOURCE_REMOVE;
            }
        );
        
        this._pendingIdentification.set(window, timeoutId);
    }
    
    /**
     * Schedules size restoration for a newly created window.
     * For Nautilus windows, waits for location-based ID before restoring.
     */
    _scheduleRestoration(window) {
        const windowId = this._getWindowId(window);

        if (!windowId)
            return;

        // For Nautilus windows with generic ID, wait for potential location-based ID
        // GNOME dynamically updates Nautilus window app IDs to include location info
        if (windowId === 'org.gnome.nautilus') {
            console.log(`[WindowSizeTracker] Nautilus window detected, waiting for location ID...`);
            this._waitForNautilusLocationId(window, 0);
            return;
        }

        // Normal restoration flow for non-Nautilus windows
        this._doRestoration(window, windowId);
    }

    /**
     * Waits for Nautilus window to get a location-based app ID.
     * GNOME updates the app association shortly after window creation.
     */
    _waitForNautilusLocationId(window, attempt) {
        if (attempt >= NAUTILUS_LOCATION_MAX_ATTEMPTS) {
            // Give up waiting, use generic nautilus ID
            console.log(`[WindowSizeTracker] No location ID after ${attempt} attempts, using generic "org.gnome.nautilus"`);
            this._doRestoration(window, 'org.gnome.nautilus');
            return;
        }

        // Clear any existing pending restoration for this window
        this._clearPendingRestoration(window);

        const timeoutId = GLib.timeout_add(
            GLib.PRIORITY_DEFAULT,
            NAUTILUS_LOCATION_WAIT_MS,
            () => {
                this._pendingRestoration.delete(window);

                // Check if window is still valid
                try {
                    if (!window.get_compositor_private())
                        return GLib.SOURCE_REMOVE;
                } catch (e) {
                    return GLib.SOURCE_REMOVE;
                }

                const newId = this._getWindowId(window);

                if (this._isLocationBasedId(newId)) {
                    // Got location-based ID, proceed with restoration
                    console.log(`[WindowSizeTracker] Nautilus location ID detected: "${newId}"`);
                    this._doRestoration(window, newId);
                } else {
                    // Still generic, keep waiting
                    console.log(`[WindowSizeTracker] Waiting for Nautilus location ID (attempt ${attempt + 1})...`);
                    this._waitForNautilusLocationId(window, attempt + 1);
                }

                return GLib.SOURCE_REMOVE;
            }
        );

        this._pendingRestoration.set(window, { timeoutId });
    }

    /**
     * Performs the actual restoration for a window with a known stable ID.
     * Uses a multi-pronged approach for fastest possible restoration:
     * 1. Try immediate restoration (window may already be ready)
     * 2. Connect to first-frame signal on the actor (fires just before first paint)
     * 3. Set a short fallback timeout in case first-frame doesn't fire
     */
    _doRestoration(window, windowId) {
        // Create a unique key for this window instance
        const windowInstanceKey = `${windowId}:${window.get_stable_sequence()}`;

        // Check if already restored
        if (this._restoredWindows.has(windowInstanceKey))
            return;

        // Get saved size
        const savedSize = this._dataStore.get(windowId);

        if (!savedSize) {
            console.log(`[WindowSizeTracker] STATE RESTORE: No saved state for "${windowId}"`);
            return;
        }

        console.log(`[WindowSizeTracker] STATE RESTORE: Found saved state for "${windowId}" -> ${savedSize.width}x${savedSize.height}, attempting restoration...`);

        // Clear any existing pending restoration
        this._clearPendingRestoration(window);

        // Strategy 1: Try immediate restoration - window might already be ready
        const immediateSuccess = this._restoreWindowSize(window, savedSize, windowInstanceKey);
        if (immediateSuccess) {
            return;
        }

        // Strategy 2 & 3: Use first-frame signal with fallback timeout
        const pending = {};

        // Get the window actor for first-frame signal
        const actor = window.get_compositor_private();
        if (actor) {
            pending.signalId = actor.connect('first-frame', () => {
                this._clearPendingRestoration(window);
                this._restoreWindowSize(window, savedSize, windowInstanceKey);
            });
        }

        // Fallback timeout in case first-frame doesn't fire or window needs more time
        pending.timeoutId = GLib.timeout_add(
            GLib.PRIORITY_DEFAULT,
            RESTORE_FALLBACK_DELAY_MS,
            () => {
                // Clear the signal if it exists
                if (pending.signalId && actor) {
                    try {
                        actor.disconnect(pending.signalId);
                    } catch (e) {
                        // Ignore
                    }
                }
                pending.signalId = null;
                pending.timeoutId = null;
                this._pendingRestoration.delete(window);

                // Attempt restoration with retry logic
                this._attemptRestoration(window, savedSize, windowInstanceKey, 0);

                return GLib.SOURCE_REMOVE;
            }
        );

        this._pendingRestoration.set(window, pending);
    }
    
    /**
     * Clears any pending restoration for a window.
     */
    _clearPendingRestoration(window) {
        const pending = this._pendingRestoration.get(window);
        if (pending) {
            if (pending.timeoutId) {
                GLib.Source.remove(pending.timeoutId);
            }
            if (pending.signalId) {
                try {
                    const actor = window.get_compositor_private();
                    if (actor)
                        actor.disconnect(pending.signalId);
                } catch (e) {
                    // Actor may be gone
                }
            }
            this._pendingRestoration.delete(window);
        }
    }
    
    /**
     * Attempts to restore window size with retry logic.
     * Used as fallback when immediate/first-frame restoration fails.
     */
    _attemptRestoration(window, savedSize, windowInstanceKey, attempt) {
        // Max attempts to prevent infinite loops
        const MAX_RESTORE_ATTEMPTS = 5;
        const RESTORE_RETRY_DELAY_MS = 50;
        
        if (attempt >= MAX_RESTORE_ATTEMPTS)
            return;
        
        // Check if already restored
        if (this._restoredWindows.has(windowInstanceKey))
            return;
        
        // Try to restore now
        const success = this._restoreWindowSize(window, savedSize, windowInstanceKey);
        
        if (!success) {
            // Schedule retry
            const pending = {
                timeoutId: GLib.timeout_add(
                    GLib.PRIORITY_DEFAULT,
                    RESTORE_RETRY_DELAY_MS,
                    () => {
                        this._pendingRestoration.delete(window);
                        this._attemptRestoration(window, savedSize, windowInstanceKey, attempt + 1);
                        return GLib.SOURCE_REMOVE;
                    }
                )
            };
            this._pendingRestoration.set(window, pending);
        }
    }
    
    /**
     * Restores the saved size to a window and centers it on the screen.
     * @returns {boolean} True if restoration was successful
     */
    _restoreWindowSize(window, savedSize, windowInstanceKey) {
        try {
            // Verify window is still valid and mapped
            if (!window.get_compositor_private())
                return false;
            
            // Don't restore if window is maximized or fullscreen
            // GNOME 49: Use is_maximized() instead of get_maximized()
            if (window.is_maximized() || window.fullscreen) {
                // Mark as "restored" so we don't keep retrying
                this._restoredWindows.add(windowInstanceKey);
                return true;
            }
            
            // Don't restore if window is minimized - retry later
            if (window.minimized)
                return false;
            
            // Get current geometry to check if window is ready
            const frameRect = window.get_frame_rect();
            
            // If the window has no size yet, it's not ready
            if (frameRect.width === 0 || frameRect.height === 0)
                return false;
            
            // Validate saved dimensions
            const {width, height} = savedSize;
            
            if (width < MIN_WINDOW_SIZE || height < MIN_WINDOW_SIZE)
                return false;
            
            // Get monitor work area to ensure window fits
            // GNOME 49: Use workspace's get_work_area_for_monitor method
            const monitorIndex = window.get_monitor();
            const workspace = window.get_workspace();
            if (!workspace)
                return false;
            const workArea = workspace.get_work_area_for_monitor(monitorIndex);
            
            // Clamp dimensions to work area
            const newWidth = Math.min(width, workArea.width);
            const newHeight = Math.min(height, workArea.height);
            
            // Calculate centered position within work area
            const newX = workArea.x + Math.floor((workArea.width - newWidth) / 2);
            const newY = workArea.y + Math.floor((workArea.height - newHeight) / 2);
            
            // Check if we actually need to change anything
            const TOLERANCE = 5;
            const sizeMatch = Math.abs(frameRect.width - newWidth) <= TOLERANCE &&
                              Math.abs(frameRect.height - newHeight) <= TOLERANCE;
            const posMatch = Math.abs(frameRect.x - newX) <= TOLERANCE &&
                             Math.abs(frameRect.y - newY) <= TOLERANCE;
            
            if (sizeMatch && posMatch) {
                // Already at the right size and position
                this._restoredWindows.add(windowInstanceKey);
                return true;
            }
            
            // Apply the new size and centered position
            window.move_resize_frame(true, newX, newY, newWidth, newHeight);
            
            // Mark as restored
            this._restoredWindows.add(windowInstanceKey);
            
            console.log(`[WindowSizeTracker] STATE RESTORED: "${this._getWindowId(window)}" -> ${newWidth}x${newHeight} centered at (${newX}, ${newY})`);
            
            return true;
            
        } catch (e) {
            console.error(`[WindowSizeTracker] Error restoring window: ${e.message}`);
            return false;
        }
    }
    
    /**
     * Handles window size change events (debounced).
     */
    _onSizeChanged(window) {
        const windowId = this._getWindowId(window);
        const frameRect = window.get_frame_rect();
        console.log(`[WindowSizeTracker] UPDATE DETECTED: "${windowId}" size-changed to ${frameRect.width}x${frameRect.height}`);
        
        // Clear existing timer for this window
        const existingTimer = this._sizeChangeTimers.get(window);
        if (existingTimer) {
            GLib.Source.remove(existingTimer);
        }
        
        // Schedule debounced save
        const timeoutId = GLib.timeout_add(
            GLib.PRIORITY_DEFAULT,
            SIZE_CHANGE_DEBOUNCE_MS,
            () => {
                this._sizeChangeTimers.delete(window);
                this._saveWindowSize(window);
                return GLib.SOURCE_REMOVE;
            }
        );
        
        this._sizeChangeTimers.set(window, timeoutId);
    }
    
    /**
     * Handles resize operation completion (grab-op-end).
     */
    _onGrabOpEnd(display, window, grabOp) {
        if (!window)
            return;
        
        // Check if this was a resize operation
        // Use explicit checks for all resize grab operations
        const resizeOps = [
            Meta.GrabOp.RESIZING_NW,
            Meta.GrabOp.RESIZING_N,
            Meta.GrabOp.RESIZING_NE,
            Meta.GrabOp.RESIZING_W,
            Meta.GrabOp.RESIZING_E,
            Meta.GrabOp.RESIZING_SW,
            Meta.GrabOp.RESIZING_S,
            Meta.GrabOp.RESIZING_SE,
        ];
        
        const isResize = resizeOps.includes(grabOp);
        
        if (!isResize)
            return;
        
        if (!this._isTrackableWindow(window))
            return;
        
        const windowId = this._getWindowId(window);
        const frameRect = window.get_frame_rect();
        console.log(`[WindowSizeTracker] UPDATE DETECTED: "${windowId}" resize grab ended at ${frameRect.width}x${frameRect.height}`);
        
        // Save immediately after resize completes (user intent is clear)
        this._saveWindowSize(window);
    }
    
    /**
     * Handles window about to be destroyed.
     * Saves the final size before the window disappears.
     */
    _onWindowUnmanaging(window) {
        // Save final size
        if (this._isTrackableWindow(window)) {
            const windowId = this._getWindowId(window);
            console.log(`[WindowSizeTracker] UPDATE DETECTED: "${windowId}" window closing (unmanaging)`);
            this._saveWindowSize(window);
        }
        
        // Clean up tracking
        this._untrackWindow(window);
    }
    
    /**
     * Saves the current size of a window.
     */
    _saveWindowSize(window) {
        try {
            // Don't save if window is maximized or fullscreen
            // The "normal" size is already saved
            if (window.is_maximized() || window.fullscreen)
                return;
            
            // Don't save if minimized
            if (window.minimized)
                return;
            
            const windowId = this._getWindowId(window);
            
            if (!windowId)
                return;
            
            const frameRect = window.get_frame_rect();
            
            this._dataStore.set(windowId, frameRect.width, frameRect.height);
            
            console.debug(`[WindowSizeTracker] Saved ${windowId}: ${frameRect.width}x${frameRect.height}`);
            
        } catch (e) {
            console.error(`[WindowSizeTracker] Error saving window size: ${e.message}`);
        }
    }
}

// =============================================================================
// MAIN EXTENSION CLASS
// =============================================================================

export default class WindowSizeTrackerExtension extends Extension {
    constructor(metadata) {
        super(metadata);
        this._dataStore = null;
        this._windowManager = null;
    }
    
    enable() {
        console.log('[WindowSizeTracker] Enabling extension');
        
        // Check if we're running on Wayland
        if (!this._isWayland()) {
            console.error('[WindowSizeTracker] This extension only supports Wayland. X11 is not supported.');
            return;
        }
        
        // Initialize data store
        this._dataStore = new WindowDataStore(this.path, this.uuid);
        
        // Initialize window manager
        this._windowManager = new WindowSizeManager(this._dataStore);
        this._windowManager.enable();
        
        console.log('[WindowSizeTracker] Extension enabled');
    }
    
    disable() {
        console.log('[WindowSizeTracker] Disabling extension');
        
        if (this._windowManager) {
            this._windowManager.disable();
            this._windowManager = null;
        }
        
        if (this._dataStore) {
            this._dataStore.destroy();
            this._dataStore = null;
        }
        
        console.log('[WindowSizeTracker] Extension disabled');
    }
    
    /**
     * Checks if the session is running on Wayland.
     */
    _isWayland() {
        // In GNOME Shell, we can check the compositor type
        // Meta.is_wayland_compositor() returns true on Wayland
        return Meta.is_wayland_compositor();
    }
}
