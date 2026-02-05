// DOM Elements
const wrapper = document.getElementById('canvas-wrapper');
const container = document.getElementById('canvas-container');
const dropZone = document.getElementById('drop-zone');
const fileInput = document.getElementById('file-input');
const addBtn = document.getElementById('add-btn');
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

// Undo/Redo State
const undoStack = [];
const redoStack = [];
const MAX_UNDO_LEVELS = 30;
let nudgeUndoTimeout = null;
let nudgeUndoPushed = false;

// Constants
const BASE_HANDLE_SIZE = 12;
const BASE_ANCHOR_SIZE = 10;
const HANDLE_COLOR = '#4285f4';
const HANDLE_STROKE = '#fff';

// Get handle size adjusted for current zoom level
function getHandleSize() {
    return BASE_HANDLE_SIZE / stage.scaleX();
}

function getAnchorSize() {
    return BASE_ANCHOR_SIZE;
}

// Update transformer and crop handle sizes for current zoom
function updateControlSizes() {
    const anchorSize = getAnchorSize();
    const handleSize = getHandleSize();

    transformer.anchorSize(anchorSize);
    transformer.anchorCornerRadius(anchorSize * 0.2);
    transformer.borderStrokeWidth(1);

    cropHandles.forEach(handle => {
        const pos = handle.getAttr('handlePosition');
        const isHorizontal = pos === 'top' || pos === 'bottom';
        handle.width(isHorizontal ? handleSize * 2 : handleSize);
        handle.height(isHorizontal ? handleSize : handleSize * 2);
        handle.strokeWidth(1 / stage.scaleX());
    });
}

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

function generateImageId() {
    return 'img_' + Date.now().toString(36) + '_' + Math.random().toString(36).substr(2, 9);
}

function getSelectedImage() {
    const nodes = transformer.nodes();
    return nodes.length > 0 ? nodes[0] : null;
}

function findImageById(imageId) {
    return imageLayer.children.find(child =>
        child instanceof Konva.Image && child.getAttr('imageId') === imageId
    );
}

function getViewportCenter() {
    return {
        x: (stage.width() / 2 - stage.x()) / stage.scaleX(),
        y: (stage.height() / 2 - stage.y()) / stage.scaleY()
    };
}

// ============================================
// State Management (Undo/Redo Core)
// ============================================

function captureState() {
    const images = imageLayer.children.filter(child => child instanceof Konva.Image);
    const sortedImages = [...images].sort((a, b) => a.zIndex() - b.zIndex());

    return {
        version: 2,
        images: sortedImages.map((img, index) => ({
            id: img.getAttr('imageId'),
            imageRef: img.getAttr('originalImage') || img.image(),
            originalWidth: img.getAttr('originalWidth'),
            originalHeight: img.getAttr('originalHeight'),
            x: img.x(),
            y: img.y(),
            scaleX: img.scaleX(),
            scaleY: img.scaleY(),
            rotation: img.rotation(),
            cropBounds: { ...img.getAttr('cropBounds') },
            blendMode: img.getAttr('blendMode') || 'source-over',
            opacity: img.opacity(),
            name: img.name(),
            zIndex: index
        }))
    };
}

function createKonvaImageFromState(imgState) {
    const originalWidth = imgState.originalWidth;
    const originalHeight = imgState.originalHeight;
    const cropBounds = imgState.cropBounds || { top: 0, right: 0, bottom: 0, left: 0 };

    const cropX = cropBounds.left;
    const cropY = cropBounds.top;
    const cropWidth = originalWidth - cropBounds.left - cropBounds.right;
    const cropHeight = originalHeight - cropBounds.top - cropBounds.bottom;

    const konvaImage = new Konva.Image({
        image: imgState.imageRef,
        x: imgState.x,
        y: imgState.y,
        scaleX: imgState.scaleX,
        scaleY: imgState.scaleY,
        rotation: imgState.rotation,
        draggable: true,
        name: imgState.name
    });

    konvaImage.setAttr('imageId', imgState.id);
    konvaImage.setAttr('originalImage', imgState.imageRef);
    konvaImage.setAttr('originalWidth', originalWidth);
    konvaImage.setAttr('originalHeight', originalHeight);
    konvaImage.setAttr('cropBounds', cropBounds);
    konvaImage.setAttr('blendMode', imgState.blendMode);
    konvaImage.globalCompositeOperation(imgState.blendMode);
    konvaImage.opacity(imgState.opacity);

    if (cropWidth > 0 && cropHeight > 0) {
        konvaImage.crop({ x: cropX, y: cropY, width: cropWidth, height: cropHeight });
        konvaImage.width(cropWidth);
        konvaImage.height(cropHeight);
        konvaImage.offsetX(cropWidth / 2);
        konvaImage.offsetY(cropHeight / 2);
    } else {
        konvaImage.offsetX(originalWidth / 2);
        konvaImage.offsetY(originalHeight / 2);
    }

    return konvaImage;
}

function restoreState(state) {
    // Get currently selected image ID before destroying
    const selectedNode = getSelectedImage();
    const selectedId = selectedNode ? selectedNode.getAttr('imageId') : null;

    // Remove crop handles and opacity label
    removeCropHandles();
    removeOpacityLabel();

    // Destroy all existing images
    const existingImages = imageLayer.children.filter(child => child instanceof Konva.Image);
    existingImages.forEach(img => img.destroy());

    // Recreate images from state
    const sortedImages = [...state.images].sort((a, b) => a.zIndex - b.zIndex);
    sortedImages.forEach(imgState => {
        const konvaImage = createKonvaImageFromState(imgState);
        setupImageHandlers(konvaImage);
        imageLayer.add(konvaImage);
    });

    // Restore selection if the image still exists
    if (selectedId) {
        const restoredNode = findImageById(selectedId);
        if (restoredNode) {
            transformer.nodes([restoredNode]);
            updateCropHandles();
        } else {
            transformer.nodes([]);
        }
    } else {
        transformer.nodes([]);
    }

    transformer.moveToTop();
    updateDropZoneVisibility();
    imageLayer.batchDraw();
}

// ============================================
// Undo/Redo Operations
// ============================================

function pushUndo() {
    const state = captureState();
    undoStack.push(state);

    // Limit stack size
    while (undoStack.length > MAX_UNDO_LEVELS) {
        undoStack.shift();
    }

    // Clear redo stack on new action
    redoStack.length = 0;
}

function undo() {
    if (undoStack.length === 0) return;

    // Save current state to redo stack
    const currentState = captureState();
    redoStack.push(currentState);

    // Pop and restore previous state
    const previousState = undoStack.pop();
    restoreState(previousState);
}

function redo() {
    if (redoStack.length === 0) return;

    // Save current state to undo stack
    const currentState = captureState();
    undoStack.push(currentState);

    // Pop and restore redo state
    const nextState = redoStack.pop();
    restoreState(nextState);
}

// ============================================
// Image Event Handlers
// ============================================

function setupImageHandlers(konvaImage) {
    konvaImage.on('click tap', (e) => {
        e.cancelBubble = true;
        transformer.nodes([konvaImage]);
        updateCropHandles();
        imageLayer.batchDraw();
    });

    konvaImage.on('dblclick dbltap', () => {
        pushUndo();
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

    // Push undo on drag start (continuous action)
    konvaImage.on('dragstart', () => {
        pushUndo();
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
        // Push undo before adding new image
        pushUndo();

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

        konvaImage.setAttr('imageId', generateImageId());
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

// Check if image is rotated sideways (closer to 90°/270° than 0°/180°)
function isRotatedSideways(node) {
    const rot = Math.abs(node.rotation() % 180);
    return rot > 45 && rot < 135;
}

function flipHorizontal() {
    const node = getSelectedImage();
    if (!node) return;
    pushUndo();

    if (isRotatedSideways(node)) {
        node.scaleY(node.scaleY() * -1);
    } else {
        node.scaleX(node.scaleX() * -1);
    }
    updateCropHandles();
    imageLayer.batchDraw();
}

function flipVertical() {
    const node = getSelectedImage();
    if (!node) return;
    pushUndo();

    if (isRotatedSideways(node)) {
        node.scaleX(node.scaleX() * -1);
    } else {
        node.scaleY(node.scaleY() * -1);
    }
    updateCropHandles();
    imageLayer.batchDraw();
}

function rotateLeft() {
    const node = getSelectedImage();
    if (!node) return;
    pushUndo();
    node.rotation(node.rotation() - 90);
    updateCropHandles();
    imageLayer.batchDraw();
}

function rotateRight() {
    const node = getSelectedImage();
    if (!node) return;
    pushUndo();
    node.rotation(node.rotation() + 90);
    updateCropHandles();
    imageLayer.batchDraw();
}

function duplicateImage() {
    const node = getSelectedImage();
    if (!node) return;
    pushUndo();

    const clone = node.clone({
        x: node.x() + 30,
        y: node.y() + 30
    });

    clone.setAttr('imageId', generateImageId());
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
    pushUndo();
    node.moveToTop();
    transformer.moveToTop();
    updateCropHandles();
    imageLayer.batchDraw();
}

function sendToBottom() {
    const node = getSelectedImage();
    if (!node) return;
    pushUndo();
    node.moveToBottom();
    transformer.moveToTop();
    updateCropHandles();
    imageLayer.batchDraw();
}

function deleteSelected() {
    const node = getSelectedImage();
    if (!node) return;
    pushUndo();
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
    pushUndo();
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
    pushUndo();
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
    const handleSize = getHandleSize();

    const handles = ['top', 'right', 'bottom', 'left'];
    handles.forEach(position => {
        const handle = new Konva.Rect({
            width: position === 'top' || position === 'bottom' ? handleSize * 2 : handleSize,
            height: position === 'left' || position === 'right' ? handleSize * 2 : handleSize,
            fill: HANDLE_COLOR,
            stroke: HANDLE_STROKE,
            strokeWidth: 1 / stage.scaleX(),
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

        // Push undo on crop handle drag start
        handle.on('dragstart', () => {
            pushUndo();
        });

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
        const hw = handle.width();
        const hh = handle.height();
        let x, y;

        switch (pos) {
            case 'top':
                x = rect.x + rect.width / 2 - hw / 2;
                y = rect.y - hh / 2;
                break;
            case 'bottom':
                x = rect.x + rect.width / 2 - hw / 2;
                y = rect.y + rect.height - hh / 2;
                break;
            case 'left':
                x = rect.x - hw / 2;
                y = rect.y + rect.height / 2 - hh / 2;
                break;
            case 'right':
                x = rect.x + rect.width - hw / 2;
                y = rect.y + rect.height / 2 - hh / 2;
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
    const hw = handle.width();
    const hh = handle.height();

    let visualDelta;
    switch (visualPosition) {
        case 'top':
            visualDelta = handlePos.y + hh / 2 - rect.y;
            break;
        case 'bottom':
            visualDelta = rect.y + rect.height - handlePos.y - hh / 2;
            break;
        case 'left':
            visualDelta = handlePos.x + hw / 2 - rect.x;
            break;
        case 'right':
            visualDelta = rect.x + rect.width - handlePos.x - hw / 2;
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
    pushUndo();

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

async function serializeStateToZip(state) {
    const zip = new JSZip();
    const imgFolder = zip.folder('images');

    const projectData = {
        version: 2,
        images: []
    };

    for (let i = 0; i < state.images.length; i++) {
        const imgState = state.images[i];
        const filename = `${i}.png`;

        updateProgress(
            Math.round((i / state.images.length) * 80),
            `Processing image ${i + 1} of ${state.images.length}...`
        );

        const canvas = document.createElement('canvas');
        canvas.width = imgState.imageRef.width;
        canvas.height = imgState.imageRef.height;
        const ctx = canvas.getContext('2d');
        ctx.drawImage(imgState.imageRef, 0, 0);

        const blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/png'));
        imgFolder.file(filename, blob);

        projectData.images.push({
            filename: filename,
            id: imgState.id,
            x: imgState.x,
            y: imgState.y,
            scaleX: imgState.scaleX,
            scaleY: imgState.scaleY,
            rotation: imgState.rotation,
            cropBounds: imgState.cropBounds,
            blendMode: imgState.blendMode,
            opacity: imgState.opacity,
            originalWidth: imgState.originalWidth,
            originalHeight: imgState.originalHeight,
            name: imgState.name,
            zIndex: imgState.zIndex
        });
    }

    zip.file('project.json', JSON.stringify(projectData, null, 2));

    updateProgress(90, 'Creating archive...');

    return await zip.generateAsync({
        type: 'blob',
        compression: 'DEFLATE',
        compressionOptions: { level: 6 }
    }, (metadata) => {
        updateProgress(90 + Math.round(metadata.percent * 0.1), 'Creating archive...');
    });
}

async function saveProject() {
    const state = captureState();
    if (state.images.length === 0) {
        alert('No images to save');
        return;
    }

    showProgressModal('Saving Project...');

    try {
        const content = await serializeStateToZip(state);

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

async function deserializeStateFromZip(file) {
    const zip = await JSZip.loadAsync(file);
    const projectFile = zip.file('project.json');

    if (!projectFile) {
        throw new Error('Invalid .montage file: missing project.json');
    }

    const projectData = JSON.parse(await projectFile.async('string'));
    const imgFolder = zip.folder('images');
    const totalImages = projectData.images.length;

    const state = {
        version: 2,
        images: []
    };

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

        const imageRef = await new Promise((resolve, reject) => {
            const img = new Image();
            img.onload = () => {
                URL.revokeObjectURL(imgUrl);
                resolve(img);
            };
            img.onerror = () => {
                URL.revokeObjectURL(imgUrl);
                reject(new Error(`Failed to load image: ${imgData.filename}`));
            };
            img.src = imgUrl;
        });

        state.images.push({
            id: imgData.id || generateImageId(), // Generate new ID if not present (v1 files)
            imageRef: imageRef,
            originalWidth: imgData.originalWidth || imageRef.width,
            originalHeight: imgData.originalHeight || imageRef.height,
            x: imgData.x,
            y: imgData.y,
            scaleX: imgData.scaleX,
            scaleY: imgData.scaleY,
            rotation: imgData.rotation,
            cropBounds: imgData.cropBounds || { top: 0, right: 0, bottom: 0, left: 0 },
            blendMode: imgData.blendMode || 'source-over',
            opacity: imgData.opacity !== undefined ? imgData.opacity : 1,
            name: imgData.name || `image-${i}`,
            zIndex: imgData.zIndex !== undefined ? imgData.zIndex : i
        });
    }

    return state;
}

async function loadProject(file) {
    showProgressModal('Adding from Project...');

    try {
        updateProgress(10, 'Reading archive...');
        updateProgress(20, 'Loading images...');

        const loadedState = await deserializeStateFromZip(file);

        // Calculate offset to center loaded images in current viewport
        let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
        for (const imgState of loadedState.images) {
            minX = Math.min(minX, imgState.x);
            minY = Math.min(minY, imgState.y);
            maxX = Math.max(maxX, imgState.x);
            maxY = Math.max(maxY, imgState.y);
        }
        const savedCenterX = (minX + maxX) / 2;
        const savedCenterY = (minY + maxY) / 2;

        const center = getViewportCenter();
        const offsetX = center.x - savedCenterX;
        const offsetY = center.y - savedCenterY;

        // Offset images to viewport center and assign new IDs
        loadedState.images.forEach(imgState => {
            imgState.x += offsetX;
            imgState.y += offsetY;
            imgState.id = generateImageId(); // Always assign new ID on load
        });

        // Push undo before merging
        pushUndo();

        // Merge with current state - add loaded images to canvas
        const currentState = captureState();
        const maxCurrentZIndex = currentState.images.length > 0
            ? Math.max(...currentState.images.map(img => img.zIndex))
            : -1;

        // Adjust zIndex of loaded images to be above current images
        loadedState.images.forEach((imgState, i) => {
            imgState.zIndex = maxCurrentZIndex + 1 + i;
        });

        // Merge states
        const mergedState = {
            version: 2,
            images: [...currentState.images, ...loadedState.images]
        };

        restoreState(mergedState);
        imageCount += loadedState.images.length;

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
    updateControlSizes();
    updateCropHandles();
    stage.batchDraw();

    zoomLevelSpan.textContent = Math.round(newScale * 100) + '%';
});

stage.on('dragmove', () => {
    updateCropHandles();
});

// Transformer events
transformer.on('transformstart', () => {
    pushUndo();
});
transformer.on('transform', updateCropHandles);
transformer.on('transformend', updateCropHandles);

// Button handlers
addBtn.addEventListener('click', () => fileInput.click());
fileInput.addEventListener('change', (e) => handleFiles(e.target.files));

function toggleBackground() {
    document.body.classList.toggle('light-bg');
}

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
    // Undo: Ctrl+Z
    if (e.key === 'z' && (e.ctrlKey || e.metaKey) && !e.shiftKey) {
        e.preventDefault();
        undo();
        return;
    }
    // Redo: Ctrl+Shift+Z or Ctrl+Y
    if ((e.key === 'z' || e.key === 'Z') && (e.ctrlKey || e.metaKey) && e.shiftKey) {
        e.preventDefault();
        redo();
        return;
    }
    if (e.key === 'y' && (e.ctrlKey || e.metaKey)) {
        e.preventDefault();
        redo();
        return;
    }

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

    // Helper for debounced nudge undo
    function handleNudge(axis, amount) {
        // Push undo once at start of nudge sequence
        if (!nudgeUndoPushed) {
            pushUndo();
            nudgeUndoPushed = true;
        }
        // Reset idle timer - after 500ms without nudge, allow new undo
        if (nudgeUndoTimeout) clearTimeout(nudgeUndoTimeout);
        nudgeUndoTimeout = setTimeout(() => {
            nudgeUndoPushed = false;
        }, 500);

        const current = axis === 'x' ? node.x() : node.y();
        const newVal = shouldSnap ? Math.round(current + amount) : current + amount;
        if (axis === 'x') node.x(newVal);
        else node.y(newVal);
        updateCropHandles();
    }

    switch (e.key) {
        case 'ArrowLeft':
            handleNudge('x', -moveAmount);
            break;
        case 'ArrowRight':
            handleNudge('x', moveAmount);
            break;
        case 'ArrowUp':
            handleNudge('y', -moveAmount);
            break;
        case 'ArrowDown':
            handleNudge('y', moveAmount);
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
