// DOM Elements
const wrapper = document.getElementById('canvas-wrapper');
const container = document.getElementById('canvas-container');
const dropZone = document.getElementById('drop-zone');
const fileInput = document.getElementById('file-input');
const addBtn = document.getElementById('add-btn');
const resetViewBtn = document.getElementById('reset-view-btn');
const bgToggleBtn = document.getElementById('bg-toggle-btn');
const zoomLevelSpan = document.getElementById('zoom-level');

// Initialize Konva stage
const stage = new Konva.Stage({
    container: 'canvas-container',
    width: wrapper.clientWidth,
    height: wrapper.clientHeight,
    draggable: true
});

// Layer for images
const imageLayer = new Konva.Layer();
stage.add(imageLayer);

// Transformer for selected images
const transformer = new Konva.Transformer({
    keepRatio: true,
    enabledAnchors: ['top-left', 'top-right', 'bottom-left', 'bottom-right'],
    rotateEnabled: false,
    boundBoxFunc: (oldBox, newBox) => {
        if (newBox.width < 20 || newBox.height < 20) {
            return oldBox;
        }
        return newBox;
    }
});
imageLayer.add(transformer);

// State
let imageCount = 0;
let cropHandles = [];
let cropHandlesNodeId = null;
let contextMenu = null;
let progressModal = null;
let opacityInput = { firstDigit: null, timeout: null };
let opacityLabel = null;

// Constants
const HANDLE_SIZE = 12;
const HANDLE_COLOR = '#4285f4';
const HANDLE_STROKE = '#fff';

const blendModes = [
    { value: 'source-over', label: 'Normal' },
    { value: 'screen', label: 'Screen' },
    { value: 'multiply', label: 'Multiply' },
    { value: 'lighten', label: 'Lighten' },
    { value: 'darken', label: 'Darken' },
    { value: 'overlay', label: 'Overlay' },
    { value: 'soft-light', label: 'Soft Light' },
    { value: 'difference', label: 'Difference' }
];

// ============================================
// Utility Functions
// ============================================

function getSelectedImage() {
    const nodes = transformer.nodes();
    return nodes.length > 0 ? nodes[0] : null;
}

function getViewportCenter() {
    return {
        x: (stage.width() / 2 - stage.x()) / stage.scaleX(),
        y: (stage.height() / 2 - stage.y()) / stage.scaleY()
    };
}

function setupImageHandlers(konvaImage) {
    konvaImage.on('click tap', (e) => {
        e.cancelBubble = true;
        transformer.nodes([konvaImage]);
        updateCropHandles();
        imageLayer.batchDraw();
    });

    konvaImage.on('dblclick dbltap', () => {
        konvaImage.moveToTop();
        transformer.moveToTop();
        updateCropHandles();
        imageLayer.batchDraw();
    });

    konvaImage.on('contextmenu', (e) => {
        e.evt.preventDefault();
        e.cancelBubble = true;
        transformer.nodes([konvaImage]);
        updateCropHandles();
        showContextMenu(e.evt.clientX, e.evt.clientY, konvaImage);
        imageLayer.batchDraw();
    });

    konvaImage.on('dragmove', () => {
        updateCropHandles();
    });
}

// ============================================
// Image Loading
// ============================================

function addImage(src, fileName) {
    const img = new Image();
    img.onload = () => {
        let scale = 1;
        const maxDim = Math.min(stage.width(), stage.height()) * 0.6;
        if (img.width > maxDim || img.height > maxDim) {
            scale = maxDim / Math.max(img.width, img.height);
        }

        const center = getViewportCenter();

        const konvaImage = new Konva.Image({
            image: img,
            x: center.x + imageCount * 30,
            y: center.y + imageCount * 30,
            scaleX: scale,
            scaleY: scale,
            offsetX: img.width / 2,
            offsetY: img.height / 2,
            draggable: true,
            name: fileName || `image-${imageCount}`
        });

        konvaImage.setAttr('originalImage', img);
        konvaImage.setAttr('originalWidth', img.width);
        konvaImage.setAttr('originalHeight', img.height);
        konvaImage.setAttr('cropBounds', { top: 0, right: 0, bottom: 0, left: 0 });
        konvaImage.setAttr('blendMode', 'source-over');

        setupImageHandlers(konvaImage);

        imageLayer.add(konvaImage);
        transformer.nodes([konvaImage]);
        transformer.moveToTop();
        updateCropHandles();
        imageLayer.batchDraw();

        imageCount++;
        updateDropZoneVisibility();
    };
    img.src = src;
}

// ============================================
// File Handling
// ============================================

function isHeicFile(file) {
    const name = file.name.toLowerCase();
    return name.endsWith('.heic') || name.endsWith('.heif') ||
           file.type === 'image/heic' || file.type === 'image/heif';
}

function isMontageFile(file) {
    return file.name.toLowerCase().endsWith('.montage');
}

async function convertHeicToDataUrl(file) {
    const convertedBlob = await HeicTo({
        blob: file,
        type: 'image/png',
        quality: 1
    });

    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result);
        reader.onerror = reject;
        reader.readAsDataURL(convertedBlob);
    });
}

function showHeicLoading(fileName) {
    let el = document.querySelector('.heic-loading');
    if (!el) {
        el = document.createElement('div');
        el.className = 'heic-loading';
        document.body.appendChild(el);
    }
    el.textContent = `Converting from HEIC: ${fileName}...`;
    el.style.display = 'block';
}

function hideHeicLoading() {
    const el = document.querySelector('.heic-loading');
    if (el) el.style.display = 'none';
}

async function handleFiles(files) {
    for (const file of Array.from(files)) {
        try {
            if (isMontageFile(file)) {
                await loadProject(file);
            } else if (isHeicFile(file)) {
                showHeicLoading(file.name);
                const dataUrl = await convertHeicToDataUrl(file);
                hideHeicLoading();
                addImage(dataUrl, file.name.replace(/\.heic$/i, '.png').replace(/\.heif$/i, '.png'));
            } else if (file.type.startsWith('image/') || file.type === '') {
                const reader = new FileReader();
                reader.onload = (e) => addImage(e.target.result, file.name);
                reader.readAsDataURL(file);
            }
        } catch (err) {
            hideHeicLoading();
            console.error('Error loading file:', file.name, err);
            alert(`Could not load ${file.name}: ${err.message}`);
        }
    }
}

// ============================================
// UI State
// ============================================

function updateDropZoneVisibility() {
    const hasImages = imageLayer.children.length > 1;
    dropZone.classList.toggle('empty', !hasImages);
    dropZone.querySelector('.drop-hint').style.display = hasImages ? 'none' : 'block';
}

// ============================================
// Image Transform Operations
// ============================================

function flipHorizontal() {
    const node = getSelectedImage();
    if (!node) return;
    node.scaleX(node.scaleX() * -1);
    updateCropHandles();
    imageLayer.batchDraw();
}

function flipVertical() {
    const node = getSelectedImage();
    if (!node) return;
    node.scaleY(node.scaleY() * -1);
    updateCropHandles();
    imageLayer.batchDraw();
}

function rotateLeft() {
    const node = getSelectedImage();
    if (!node) return;
    node.rotation(node.rotation() - 90);
    updateCropHandles();
    imageLayer.batchDraw();
}

function rotateRight() {
    const node = getSelectedImage();
    if (!node) return;
    node.rotation(node.rotation() + 90);
    updateCropHandles();
    imageLayer.batchDraw();
}

function duplicateImage() {
    const node = getSelectedImage();
    if (!node) return;

    const clone = node.clone({
        x: node.x() + 30,
        y: node.y() + 30
    });

    clone.setAttr('originalImage', node.getAttr('originalImage'));
    clone.setAttr('originalWidth', node.getAttr('originalWidth'));
    clone.setAttr('originalHeight', node.getAttr('originalHeight'));
    clone.setAttr('cropBounds', { ...node.getAttr('cropBounds') });
    clone.setAttr('blendMode', node.getAttr('blendMode'));
    clone.globalCompositeOperation(node.getAttr('blendMode') || 'source-over');

    setupImageHandlers(clone);

    imageLayer.add(clone);
    transformer.nodes([clone]);
    transformer.moveToTop();
    updateCropHandles();
    imageLayer.batchDraw();
    imageCount++;
}

function bringToTop() {
    const node = getSelectedImage();
    if (!node) return;
    node.moveToTop();
    transformer.moveToTop();
    updateCropHandles();
    imageLayer.batchDraw();
}

function sendToBottom() {
    const node = getSelectedImage();
    if (!node) return;
    node.moveToBottom();
    transformer.moveToTop();
    updateCropHandles();
    imageLayer.batchDraw();
}

function deleteSelected() {
    const node = getSelectedImage();
    if (!node) return;
    node.destroy();
    transformer.nodes([]);
    removeCropHandles();
    removeOpacityLabel();
    updateDropZoneVisibility();
    imageLayer.batchDraw();
}

// ============================================
// Blend Modes
// ============================================

function setBlendMode(mode) {
    const node = getSelectedImage();
    if (!node) return;
    node.setAttr('blendMode', mode);
    node.globalCompositeOperation(mode);
    imageLayer.batchDraw();
}

function cycleBlendMode() {
    const node = getSelectedImage();
    if (!node) return;
    const currentMode = node.getAttr('blendMode') || 'source-over';
    const currentIndex = blendModes.findIndex(m => m.value === currentMode);
    const nextIndex = (currentIndex + 1) % blendModes.length;
    const nextMode = blendModes[nextIndex];
    setBlendMode(nextMode.value);
    console.log('Blend mode:', nextMode.label);
}

// ============================================
// Opacity (Photoshop-style number keys)
// ============================================

function setOpacity(percent) {
    const node = getSelectedImage();
    if (!node) return;
    const opacity = Math.max(0, Math.min(100, percent)) / 100;
    node.opacity(opacity);
    updateOpacityLabel(node);
    imageLayer.batchDraw();
}

function handleOpacityKey(digit) {
    const node = getSelectedImage();
    if (!node) return true; // consume the key even if no selection

    if (opacityInput.timeout) {
        clearTimeout(opacityInput.timeout);
    }

    if (opacityInput.firstDigit !== null) {
        // Second digit - combine for precise value
        const percent = opacityInput.firstDigit * 10 + digit;
        setOpacity(percent);
        opacityInput.firstDigit = null;
        opacityInput.timeout = null;
    } else {
        // First digit - wait briefly for second digit
        opacityInput.firstDigit = digit;
        opacityInput.timeout = setTimeout(() => {
            // No second digit came - use single digit value
            // 0 = 100%, 1-9 = 10%-90%
            const percent = opacityInput.firstDigit === 0 ? 100 : opacityInput.firstDigit * 10;
            setOpacity(percent);
            opacityInput.firstDigit = null;
            opacityInput.timeout = null;
        }, 300); // 300ms window for second digit
    }

    return true;
}

// ============================================
// Crop Handles
// ============================================

function createCropHandles(node) {
    removeCropHandles();
    const nodeId = node._id;

    const handles = ['top', 'right', 'bottom', 'left'];
    handles.forEach(position => {
        const handle = new Konva.Rect({
            width: position === 'top' || position === 'bottom' ? HANDLE_SIZE * 2 : HANDLE_SIZE,
            height: position === 'left' || position === 'right' ? HANDLE_SIZE * 2 : HANDLE_SIZE,
            fill: HANDLE_COLOR,
            stroke: HANDLE_STROKE,
            strokeWidth: 1,
            cornerRadius: 2,
            draggable: true,
            name: `crop-handle-${position}`
        });

        handle.setAttr('handlePosition', position);
        handle.setAttr('targetNodeId', nodeId);

        const cursors = { top: 'ns-resize', bottom: 'ns-resize', left: 'ew-resize', right: 'ew-resize' };
        handle.on('mouseenter', () => { stage.container().style.cursor = cursors[position]; });
        handle.on('mouseleave', () => { stage.container().style.cursor = 'default'; });

        handle.on('click tap', (e) => { e.cancelBubble = true; });
        handle.on('mousedown touchstart', (e) => { e.cancelBubble = true; });

        handle.on('dragmove', (e) => {
            e.cancelBubble = true;
            const selectedNodes = transformer.nodes();
            if (selectedNodes.length === 0) return;
            const currentNode = selectedNodes[0];
            if (currentNode._id !== nodeId) return;
            updateCropFromHandle(currentNode, handle, position);
        });

        handle.on('dragend', (e) => {
            e.cancelBubble = true;
            const selectedNodes = transformer.nodes();
            if (selectedNodes.length === 0) return;
            const currentNode = selectedNodes[0];
            if (currentNode._id !== nodeId) return;
            positionCropHandles(currentNode);
        });

        imageLayer.add(handle);
        cropHandles.push(handle);
    });

    positionCropHandles(node);
}

function removeCropHandles() {
    cropHandles.forEach(handle => handle.destroy());
    cropHandles = [];
    cropHandlesNodeId = null;
}

function positionCropHandles(node) {
    if (cropHandles.length === 0) return;

    const rect = node.getClientRect({ relativeTo: stage });

    cropHandles.forEach(handle => {
        const pos = handle.getAttr('handlePosition');
        let x, y;

        switch (pos) {
            case 'top':
                x = rect.x + rect.width / 2 - (HANDLE_SIZE * 2) / 2;
                y = rect.y - HANDLE_SIZE / 2;
                break;
            case 'bottom':
                x = rect.x + rect.width / 2 - (HANDLE_SIZE * 2) / 2;
                y = rect.y + rect.height - HANDLE_SIZE / 2;
                break;
            case 'left':
                x = rect.x - HANDLE_SIZE / 2;
                y = rect.y + rect.height / 2 - (HANDLE_SIZE * 2) / 2;
                break;
            case 'right':
                x = rect.x + rect.width - HANDLE_SIZE / 2;
                y = rect.y + rect.height / 2 - (HANDLE_SIZE * 2) / 2;
                break;
        }

        handle.position({ x, y });
    });

    cropHandles.forEach(h => h.moveToTop());
}

function getSourceEdge(visualHandle, rotation, scaleX, scaleY) {
    let rot = ((rotation % 360) + 360) % 360;
    rot = Math.round(rot / 90) * 90 % 360;

    const rotationMaps = {
        0:   { top: 'top', right: 'right', bottom: 'bottom', left: 'left' },
        90:  { top: 'left', right: 'top', bottom: 'right', left: 'bottom' },
        180: { top: 'bottom', right: 'left', bottom: 'top', left: 'right' },
        270: { top: 'right', right: 'bottom', bottom: 'left', left: 'top' }
    };

    let sourceEdge = rotationMaps[rot][visualHandle];

    if (scaleX < 0) {
        if (sourceEdge === 'left') sourceEdge = 'right';
        else if (sourceEdge === 'right') sourceEdge = 'left';
    }
    if (scaleY < 0) {
        if (sourceEdge === 'top') sourceEdge = 'bottom';
        else if (sourceEdge === 'bottom') sourceEdge = 'top';
    }

    return sourceEdge;
}

function updateCropFromHandle(node, handle, visualPosition) {
    if (!node || node.isDestroyed || !node.getAttr('originalWidth')) return;

    const originalWidth = node.getAttr('originalWidth');
    const originalHeight = node.getAttr('originalHeight');
    const currentCrop = node.getAttr('cropBounds') || { top: 0, right: 0, bottom: 0, left: 0 };

    const rect = node.getClientRect({ relativeTo: stage });
    const handlePos = handle.position();
    const scaleX = node.scaleX();
    const scaleY = node.scaleY();
    const absScaleX = Math.abs(scaleX);
    const absScaleY = Math.abs(scaleY);
    const rotation = node.rotation();

    const sourceEdge = getSourceEdge(visualPosition, rotation, scaleX, scaleY);

    let visualDelta;
    switch (visualPosition) {
        case 'top':
            visualDelta = handlePos.y + HANDLE_SIZE / 2 - rect.y;
            break;
        case 'bottom':
            visualDelta = rect.y + rect.height - handlePos.y - HANDLE_SIZE / 2;
            break;
        case 'left':
            visualDelta = handlePos.x + HANDLE_SIZE / 2 - rect.x;
            break;
        case 'right':
            visualDelta = rect.x + rect.width - handlePos.x - HANDLE_SIZE / 2;
            break;
    }

    const isVisualHorizontal = (visualPosition === 'left' || visualPosition === 'right');
    const scale = isVisualHorizontal ? absScaleX : absScaleY;
    const sourceDelta = visualDelta / scale;

    let newCrop = { ...currentCrop };
    const minSize = 20;

    switch (sourceEdge) {
        case 'top':
            newCrop.top = Math.max(0, Math.min(originalHeight - currentCrop.bottom - minSize, currentCrop.top + sourceDelta));
            break;
        case 'bottom':
            newCrop.bottom = Math.max(0, Math.min(originalHeight - currentCrop.top - minSize, currentCrop.bottom + sourceDelta));
            break;
        case 'left':
            newCrop.left = Math.max(0, Math.min(originalWidth - currentCrop.right - minSize, currentCrop.left + sourceDelta));
            break;
        case 'right':
            newCrop.right = Math.max(0, Math.min(originalWidth - currentCrop.left - minSize, currentCrop.right + sourceDelta));
            break;
    }

    applyCropBounds(node, newCrop, sourceEdge);
}

function applyCropBounds(node, cropBounds, sourceEdgeBeingCropped) {
    if (!node || node.isDestroyed) return;

    const originalWidth = node.getAttr('originalWidth');
    const originalHeight = node.getAttr('originalHeight');

    if (!originalWidth || !originalHeight) return;

    const cropX = cropBounds.left;
    const cropY = cropBounds.top;
    const cropWidth = originalWidth - cropBounds.left - cropBounds.right;
    const cropHeight = originalHeight - cropBounds.top - cropBounds.bottom;

    if (cropWidth <= 0 || cropHeight <= 0) return;

    const anchorSourceEdge = {
        'left': 'right',
        'right': 'left',
        'top': 'bottom',
        'bottom': 'top'
    }[sourceEdgeBeingCropped];

    const rectBefore = node.getClientRect({ relativeTo: stage });

    node.setAttr('cropBounds', cropBounds);
    node.crop({ x: cropX, y: cropY, width: cropWidth, height: cropHeight });
    node.width(cropWidth);
    node.height(cropHeight);
    node.offsetX(cropWidth / 2);
    node.offsetY(cropHeight / 2);

    const rectAfter = node.getClientRect({ relativeTo: stage });

    if (anchorSourceEdge) {
        const rotation = node.rotation();
        const scaleX = node.scaleX();
        const scaleY = node.scaleY();

        let rot = ((rotation % 360) + 360) % 360;
        rot = Math.round(rot / 90) * 90 % 360;

        let flippedEdge = anchorSourceEdge;
        if (scaleX < 0) {
            if (flippedEdge === 'left') flippedEdge = 'right';
            else if (flippedEdge === 'right') flippedEdge = 'left';
        }
        if (scaleY < 0) {
            if (flippedEdge === 'top') flippedEdge = 'bottom';
            else if (flippedEdge === 'bottom') flippedEdge = 'top';
        }

        const visualMaps = {
            0:   { top: 'top', right: 'right', bottom: 'bottom', left: 'left' },
            90:  { top: 'right', right: 'bottom', bottom: 'left', left: 'top' },
            180: { top: 'bottom', right: 'left', bottom: 'top', left: 'right' },
            270: { top: 'left', right: 'top', bottom: 'right', left: 'bottom' }
        };

        let visualAnchor = visualMaps[rot][flippedEdge];

        let dx = 0, dy = 0;
        switch (visualAnchor) {
            case 'left':
                dx = rectBefore.x - rectAfter.x;
                break;
            case 'right':
                dx = (rectBefore.x + rectBefore.width) - (rectAfter.x + rectAfter.width);
                break;
            case 'top':
                dy = rectBefore.y - rectAfter.y;
                break;
            case 'bottom':
                dy = (rectBefore.y + rectBefore.height) - (rectAfter.y + rectAfter.height);
                break;
        }

        node.x(node.x() + dx);
        node.y(node.y() + dy);
    }

    imageLayer.batchDraw();
}

function resetCrop() {
    const node = getSelectedImage();
    if (!node) return;

    const originalWidth = node.getAttr('originalWidth');
    const originalHeight = node.getAttr('originalHeight');

    node.setAttr('cropBounds', { top: 0, right: 0, bottom: 0, left: 0 });
    node.crop({ x: 0, y: 0, width: originalWidth, height: originalHeight });
    node.width(originalWidth);
    node.height(originalHeight);
    node.offsetX(originalWidth / 2);
    node.offsetY(originalHeight / 2);

    positionCropHandles(node);
    imageLayer.batchDraw();
}

function updateCropHandles() {
    const node = getSelectedImage();
    if (!node) {
        removeCropHandles();
        removeOpacityLabel();
        cropHandlesNodeId = null;
        return;
    }

    if (cropHandlesNodeId !== node._id) {
        createCropHandles(node);
        cropHandlesNodeId = node._id;
    } else {
        positionCropHandles(node);
    }

    updateOpacityLabel(node);
}

// ============================================
// Opacity Label
// ============================================

function updateOpacityLabel(node) {
    const opacity = node.opacity();

    // Only show if opacity is not 100%
    if (opacity >= 0.999) {
        removeOpacityLabel();
        return;
    }

    const percent = Math.round(opacity * 100);
    const rect = node.getClientRect({ relativeTo: stage });
    const text = percent + '% opacity';

    if (!opacityLabel) {
        opacityLabel = new Konva.Text({
            text: text,
            fontSize: 12,
            fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
            fill: '#fff',
            padding: 4,
            listening: false
        });

        // Add background rect
        const bg = new Konva.Rect({
            fill: 'rgba(0, 0, 0, 0.7)',
            cornerRadius: 3,
            listening: false
        });
        bg.setAttr('isOpacityBg', true);
        imageLayer.add(bg);
        imageLayer.add(opacityLabel);
    }

    // Update text
    opacityLabel.text(text);

    // Get background rect
    const bg = imageLayer.children.find(c => c.getAttr('isOpacityBg'));

    // Size background to text
    const padding = 4;
    const textWidth = opacityLabel.width();
    const textHeight = opacityLabel.height();

    // Position at lower right corner of image
    const labelX = rect.x + rect.width - textWidth - 8;
    const labelY = rect.y + rect.height - textHeight - 8;

    opacityLabel.position({ x: labelX, y: labelY });

    if (bg) {
        bg.position({ x: labelX - padding, y: labelY - padding });
        bg.width(textWidth + padding * 2);
        bg.height(textHeight + padding * 2);
        bg.moveToTop();
    }

    opacityLabel.moveToTop();
}

function removeOpacityLabel() {
    if (opacityLabel) {
        // Remove background
        const bg = imageLayer.children.find(c => c.getAttr('isOpacityBg'));
        if (bg) bg.destroy();
        opacityLabel.destroy();
        opacityLabel = null;
    }
}

// ============================================
// Context Menu
// ============================================

function showContextMenu(x, y, node) {
    hideContextMenu();

    contextMenu = document.createElement('div');
    contextMenu.className = 'context-menu';

    const currentBlend = node.getAttr('blendMode') || 'source-over';
    const currentOpacity = Math.round(node.opacity() * 100);
    const blendMenuItems = blendModes.map(m =>
        `<div class="context-menu-item blend-option${m.value === currentBlend ? ' active' : ''}" data-action="blend" data-blend="${m.value}">${m.label}</div>`
    ).join('');

    contextMenu.innerHTML = `
        <div class="context-menu-item" data-action="totop">Bring to Top <span class="shortcut">T</span></div>
        <div class="context-menu-item" data-action="tobottom">Send to Bottom <span class="shortcut">G</span></div>
        <div class="context-menu-item" data-action="duplicate">Duplicate <span class="shortcut">D</span></div>
        <div class="context-menu-item" data-action="fliph">Flip Horizontal <span class="shortcut">H</span></div>
        <div class="context-menu-item" data-action="flipv">Flip Vertical <span class="shortcut">V</span></div>
        <div class="context-menu-item" data-action="resetcrop">Reset Crop</div>
        <div class="context-menu-separator"></div>
        <div class="context-menu-label">Opacity: ${currentOpacity}% <span class="shortcut">0-9</span></div>
        <div class="context-menu-separator"></div>
        <div class="context-menu-label">Blend Mode <span class="shortcut">B</span></div>
        ${blendMenuItems}
        <div class="context-menu-separator"></div>
        <div class="context-menu-item" data-action="delete">Delete <span class="shortcut">Del</span></div>
    `;
    contextMenu.style.left = x + 'px';
    contextMenu.style.top = y + 'px';

    contextMenu.addEventListener('click', (e) => {
        const item = e.target.closest('.context-menu-item');
        if (!item) return;

        const action = item.dataset.action;
        transformer.nodes([node]);

        switch (action) {
            case 'totop': bringToTop(); break;
            case 'tobottom': sendToBottom(); break;
            case 'duplicate': duplicateImage(); break;
            case 'fliph': flipHorizontal(); break;
            case 'flipv': flipVertical(); break;
            case 'resetcrop': resetCrop(); break;
            case 'blend':
                setBlendMode(item.dataset.blend);
                break;
            case 'delete':
                deleteSelected();
                break;
        }

        hideContextMenu();
        imageLayer.batchDraw();
    });

    document.body.appendChild(contextMenu);

    setTimeout(() => {
        document.addEventListener('click', hideContextMenu, { once: true });
    }, 0);
}

function hideContextMenu() {
    if (contextMenu) {
        contextMenu.remove();
        contextMenu = null;
    }
}

// ============================================
// Export
// ============================================

function exportCanvas() {
    const images = imageLayer.children.filter(child => child instanceof Konva.Image);
    if (images.length === 0) {
        alert('No images to export');
        return;
    }

    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;

    images.forEach(img => {
        const rect = img.getClientRect();
        minX = Math.min(minX, rect.x);
        minY = Math.min(minY, rect.y);
        maxX = Math.max(maxX, rect.x + rect.width);
        maxY = Math.max(maxY, rect.y + rect.height);
    });

    const exportScale = 2;
    const exportWidth = Math.round((maxX - minX) * exportScale);
    const exportHeight = Math.round((maxY - minY) * exportScale);

    const exportCanvas = document.createElement('canvas');
    exportCanvas.width = exportWidth;
    exportCanvas.height = exportHeight;
    const ctx = exportCanvas.getContext('2d');

    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, exportWidth, exportHeight);

    const sortedImages = [...images].sort((a, b) => a.zIndex() - b.zIndex());
    const stageZoom = stage.scaleX();

    sortedImages.forEach(img => {
        const originalImg = img.getAttr('originalImage') || img.image();
        const crop = img.crop();
        const scaleX = img.scaleX();
        const scaleY = img.scaleY();
        const absScaleX = Math.abs(scaleX);
        const absScaleY = Math.abs(scaleY);
        const rotation = img.rotation();
        const blendMode = img.getAttr('blendMode') || 'source-over';

        const cropX = crop.x || 0;
        const cropY = crop.y || 0;
        const cropW = crop.width || originalImg.width;
        const cropH = crop.height || originalImg.height;

        const imgRect = img.getClientRect();
        const centerX = imgRect.x + imgRect.width / 2;
        const centerY = imgRect.y + imgRect.height / 2;
        const exportX = (centerX - minX) * exportScale;
        const exportY = (centerY - minY) * exportScale;

        const drawWidth = cropW * absScaleX * stageZoom * exportScale;
        const drawHeight = cropH * absScaleY * stageZoom * exportScale;

        ctx.save();
        ctx.globalCompositeOperation = blendMode;
        ctx.globalAlpha = img.opacity();
        ctx.translate(exportX, exportY);
        ctx.rotate(rotation * Math.PI / 180);
        ctx.scale(scaleX < 0 ? -1 : 1, scaleY < 0 ? -1 : 1);

        ctx.drawImage(
            originalImg,
            cropX, cropY, cropW, cropH,
            -drawWidth / 2, -drawHeight / 2, drawWidth, drawHeight
        );

        ctx.restore();
    });

    const link = document.createElement('a');
    link.download = 'montage-export.jpg';
    link.href = exportCanvas.toDataURL('image/jpeg', 0.92);
    link.click();
}

// ============================================
// Progress Modal
// ============================================

function showProgressModal(title) {
    hideProgressModal();
    progressModal = document.createElement('div');
    progressModal.className = 'progress-modal';
    progressModal.innerHTML = `
        <h3>${title}</h3>
        <div class="progress-bar-container">
            <div class="progress-bar"></div>
        </div>
        <div class="progress-text">Preparing...</div>
    `;
    document.body.appendChild(progressModal);
}

function updateProgress(percent, text) {
    if (!progressModal) return;
    const bar = progressModal.querySelector('.progress-bar');
    const textEl = progressModal.querySelector('.progress-text');
    if (bar) bar.style.width = percent + '%';
    if (textEl) textEl.textContent = text;
}

function hideProgressModal() {
    if (progressModal) {
        progressModal.remove();
        progressModal = null;
    }
}

// ============================================
// Project Save/Load
// ============================================

async function saveProject() {
    const images = imageLayer.children.filter(child => child instanceof Konva.Image);
    if (images.length === 0) {
        alert('No images to save');
        return;
    }

    showProgressModal('Saving Project...');

    try {
        const zip = new JSZip();
        const imgFolder = zip.folder('images');
        const projectData = {
            version: 1,
            stagePosition: { x: stage.x(), y: stage.y() },
            stageScale: stage.scaleX(),
            images: []
        };

        const sortedImages = [...images].sort((a, b) => a.zIndex() - b.zIndex());

        for (let i = 0; i < sortedImages.length; i++) {
            const img = sortedImages[i];
            const originalImg = img.getAttr('originalImage') || img.image();
            const filename = `${i}.png`;

            updateProgress(
                Math.round((i / sortedImages.length) * 80),
                `Processing image ${i + 1} of ${sortedImages.length}...`
            );

            const canvas = document.createElement('canvas');
            canvas.width = originalImg.width;
            canvas.height = originalImg.height;
            const ctx = canvas.getContext('2d');
            ctx.drawImage(originalImg, 0, 0);

            const blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/png'));
            imgFolder.file(filename, blob);

            projectData.images.push({
                filename: filename,
                x: img.x(),
                y: img.y(),
                scaleX: img.scaleX(),
                scaleY: img.scaleY(),
                rotation: img.rotation(),
                cropBounds: img.getAttr('cropBounds') || { top: 0, right: 0, bottom: 0, left: 0 },
                blendMode: img.getAttr('blendMode') || 'source-over',
                opacity: img.opacity(),
                originalWidth: img.getAttr('originalWidth'),
                originalHeight: img.getAttr('originalHeight'),
                name: img.name()
            });
        }

        zip.file('project.json', JSON.stringify(projectData, null, 2));

        updateProgress(90, 'Creating archive...');

        const content = await zip.generateAsync({
            type: 'blob',
            compression: 'DEFLATE',
            compressionOptions: { level: 6 }
        }, (metadata) => {
            updateProgress(90 + Math.round(metadata.percent * 0.1), 'Creating archive...');
        });

        updateProgress(100, 'Done!');

        const link = document.createElement('a');
        link.download = 'project.montage';
        link.href = URL.createObjectURL(content);
        link.click();
        URL.revokeObjectURL(link.href);

        setTimeout(hideProgressModal, 500);

    } catch (err) {
        hideProgressModal();
        console.error('Error saving project:', err);
        alert('Failed to save project: ' + err.message);
    }
}

async function loadProject(file) {
    showProgressModal('Adding from Project...');

    try {
        updateProgress(10, 'Reading archive...');

        const zip = await JSZip.loadAsync(file);
        const projectFile = zip.file('project.json');

        if (!projectFile) {
            throw new Error('Invalid .montage file: missing project.json');
        }

        const projectData = JSON.parse(await projectFile.async('string'));

        updateProgress(20, 'Loading images...');

        // Calculate offset to center loaded images in current viewport
        let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
        for (const imgData of projectData.images) {
            minX = Math.min(minX, imgData.x);
            minY = Math.min(minY, imgData.y);
            maxX = Math.max(maxX, imgData.x);
            maxY = Math.max(maxY, imgData.y);
        }
        const savedCenterX = (minX + maxX) / 2;
        const savedCenterY = (minY + maxY) / 2;

        const center = getViewportCenter();
        const offsetX = center.x - savedCenterX;
        const offsetY = center.y - savedCenterY;

        const imgFolder = zip.folder('images');
        const totalImages = projectData.images.length;

        for (let i = 0; i < totalImages; i++) {
            const imgData = projectData.images[i];

            updateProgress(
                20 + Math.round((i / totalImages) * 75),
                `Loading image ${i + 1} of ${totalImages}...`
            );

            const imgFile = imgFolder.file(imgData.filename);
            if (!imgFile) {
                console.warn(`Missing image: ${imgData.filename}`);
                continue;
            }

            const imgBlob = await imgFile.async('blob');
            const imgUrl = URL.createObjectURL(imgBlob);

            await new Promise((resolve, reject) => {
                const img = new Image();
                img.onload = () => {
                    const konvaImage = new Konva.Image({
                        image: img,
                        x: imgData.x + offsetX,
                        y: imgData.y + offsetY,
                        scaleX: imgData.scaleX,
                        scaleY: imgData.scaleY,
                        rotation: imgData.rotation,
                        draggable: true,
                        name: imgData.name || `image-${i}`
                    });

                    konvaImage.setAttr('originalImage', img);
                    konvaImage.setAttr('originalWidth', imgData.originalWidth || img.width);
                    konvaImage.setAttr('originalHeight', imgData.originalHeight || img.height);

                    const cropBounds = imgData.cropBounds || { top: 0, right: 0, bottom: 0, left: 0 };
                    konvaImage.setAttr('cropBounds', cropBounds);

                    const originalWidth = imgData.originalWidth || img.width;
                    const originalHeight = imgData.originalHeight || img.height;
                    const cropX = cropBounds.left;
                    const cropY = cropBounds.top;
                    const cropWidth = originalWidth - cropBounds.left - cropBounds.right;
                    const cropHeight = originalHeight - cropBounds.top - cropBounds.bottom;

                    if (cropWidth > 0 && cropHeight > 0) {
                        konvaImage.crop({ x: cropX, y: cropY, width: cropWidth, height: cropHeight });
                        konvaImage.width(cropWidth);
                        konvaImage.height(cropHeight);
                        konvaImage.offsetX(cropWidth / 2);
                        konvaImage.offsetY(cropHeight / 2);
                    } else {
                        konvaImage.offsetX(img.width / 2);
                        konvaImage.offsetY(img.height / 2);
                    }

                    const blendMode = imgData.blendMode || 'source-over';
                    konvaImage.setAttr('blendMode', blendMode);
                    konvaImage.globalCompositeOperation(blendMode);

                    const opacity = imgData.opacity !== undefined ? imgData.opacity : 1;
                    konvaImage.opacity(opacity);

                    setupImageHandlers(konvaImage);

                    imageLayer.add(konvaImage);
                    URL.revokeObjectURL(imgUrl);
                    resolve();
                };
                img.onerror = () => {
                    URL.revokeObjectURL(imgUrl);
                    reject(new Error(`Failed to load image: ${imgData.filename}`));
                };
                img.src = imgUrl;
            });
        }

        transformer.moveToTop();
        imageLayer.batchDraw();
        updateDropZoneVisibility();
        imageCount += totalImages;

        updateProgress(100, 'Done!');
        setTimeout(hideProgressModal, 500);

    } catch (err) {
        hideProgressModal();
        console.error('Error loading project:', err);
        alert('Failed to load project: ' + err.message);
    }
}

// ============================================
// Event Listeners
// ============================================

// Stage events
stage.on('click tap', (e) => {
    if (e.target === stage) {
        transformer.nodes([]);
        removeCropHandles();
        removeOpacityLabel();
        imageLayer.batchDraw();
    }
});

stage.on('wheel', (e) => {
    e.evt.preventDefault();

    const oldScale = stage.scaleX();
    const pointer = stage.getPointerPosition();

    const mousePointTo = {
        x: (pointer.x - stage.x()) / oldScale,
        y: (pointer.y - stage.y()) / oldScale
    };

    const direction = e.evt.deltaY > 0 ? -1 : 1;
    const scaleBy = 1.1;
    let newScale = direction > 0 ? oldScale * scaleBy : oldScale / scaleBy;
    newScale = Math.max(0.1, Math.min(10, newScale));

    stage.scale({ x: newScale, y: newScale });

    const newPos = {
        x: pointer.x - mousePointTo.x * newScale,
        y: pointer.y - mousePointTo.y * newScale
    };
    stage.position(newPos);
    updateCropHandles();
    stage.batchDraw();

    zoomLevelSpan.textContent = Math.round(newScale * 100) + '%';
});

stage.on('dragmove', () => {
    updateCropHandles();
});

// Transformer events
transformer.on('transform', updateCropHandles);
transformer.on('transformend', updateCropHandles);

// Button handlers
addBtn.addEventListener('click', () => fileInput.click());
fileInput.addEventListener('change', (e) => handleFiles(e.target.files));

resetViewBtn.addEventListener('click', () => {
    stage.scale({ x: 1, y: 1 });
    stage.position({ x: 0, y: 0 });
    updateCropHandles();
    stage.batchDraw();
    zoomLevelSpan.textContent = '100%';
});

function toggleBackground() {
    document.body.classList.toggle('light-bg');
    const isLight = document.body.classList.contains('light-bg');
    bgToggleBtn.textContent = isLight ? '⬜ Bg' : '⬛ Bg';
}

bgToggleBtn.addEventListener('click', toggleBackground);

document.getElementById('flip-h-btn').addEventListener('click', flipHorizontal);
document.getElementById('flip-v-btn').addEventListener('click', flipVertical);
document.getElementById('rotate-l-btn').addEventListener('click', rotateLeft);
document.getElementById('rotate-r-btn').addEventListener('click', rotateRight);
document.getElementById('duplicate-btn').addEventListener('click', duplicateImage);
document.getElementById('totop-btn').addEventListener('click', bringToTop);
document.getElementById('tobottom-btn').addEventListener('click', sendToBottom);
document.getElementById('save-btn').addEventListener('click', exportCanvas);
document.getElementById('save-project-btn').addEventListener('click', saveProject);

// Prevent default context menu on canvas
container.addEventListener('contextmenu', (e) => {
    e.preventDefault();
});

// Drag and drop
wrapper.addEventListener('dragover', (e) => {
    e.preventDefault();
    dropZone.classList.add('active');
});

wrapper.addEventListener('dragleave', (e) => {
    if (!wrapper.contains(e.relatedTarget)) {
        dropZone.classList.remove('active');
    }
});

wrapper.addEventListener('drop', (e) => {
    e.preventDefault();
    dropZone.classList.remove('active');
    handleFiles(e.dataTransfer.files);
});

// Resize handling
window.addEventListener('resize', () => {
    stage.width(wrapper.clientWidth);
    stage.height(wrapper.clientHeight);
    stage.batchDraw();
});

// Keyboard shortcuts
document.addEventListener('keydown', (e) => {
    if ((e.key === 's' || e.key === 'S') && (e.ctrlKey || e.metaKey)) {
        e.preventDefault();
        saveProject();
        return;
    }
    if (e.key === 's' || e.key === 'S') {
        e.preventDefault();
        exportCanvas();
        return;
    }
    if (e.key === 'x' || e.key === 'X') {
        e.preventDefault();
        toggleBackground();
        return;
    }

    // Number keys for opacity (Photoshop-style)
    if (e.key >= '0' && e.key <= '9' && !e.ctrlKey && !e.metaKey && !e.altKey) {
        if (getSelectedImage()) {
            e.preventDefault();
            handleOpacityKey(parseInt(e.key));
            return;
        }
    }

    const node = getSelectedImage();
    if (!node) return;

    // Arrow: nudge 1 + snap | Shift+Arrow: nudge 1 no snap | Ctrl+Arrow: nudge 10 + snap
    const moveAmount = e.ctrlKey ? 10 : 1;
    const shouldSnap = !e.shiftKey;

    switch (e.key) {
        case 'ArrowLeft':
            node.x(shouldSnap ? Math.round(node.x() - moveAmount) : node.x() - moveAmount);
            updateCropHandles();
            break;
        case 'ArrowRight':
            node.x(shouldSnap ? Math.round(node.x() + moveAmount) : node.x() + moveAmount);
            updateCropHandles();
            break;
        case 'ArrowUp':
            node.y(shouldSnap ? Math.round(node.y() - moveAmount) : node.y() - moveAmount);
            updateCropHandles();
            break;
        case 'ArrowDown':
            node.y(shouldSnap ? Math.round(node.y() + moveAmount) : node.y() + moveAmount);
            updateCropHandles();
            break;
        case 'Delete':
        case 'Backspace':
            deleteSelected();
            break;
        case 'h':
        case 'H':
            flipHorizontal();
            break;
        case 'v':
        case 'V':
            flipVertical();
            break;
        case 'l':
        case 'L':
            rotateLeft();
            break;
        case 'r':
        case 'R':
            rotateRight();
            break;
        case 'd':
        case 'D':
            duplicateImage();
            break;
        case 't':
        case 'T':
            bringToTop();
            break;
        case 'g':
        case 'G':
            sendToBottom();
            break;
        case 'b':
        case 'B':
            cycleBlendMode();
            break;
        default:
            return;
    }
    e.preventDefault();
    imageLayer.batchDraw();
});
