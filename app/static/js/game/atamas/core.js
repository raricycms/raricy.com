// ============================================================
//  ATÅMAS — Core Game Engine
//  Round Disk Combination Game
//  Core mechanics:
//  1. Numbers appear from center with animation
//  2. Plus appears automatically (random) from center
//  3. Plus stays as element until merge triggered
//  4. Click ring area to choose placement position
//  5. Chain merge after each merge
//  Exposes: window.AtamasCore
// ============================================================
(function() {

var I18n = window.AtamasI18n;
var getTranslation = I18n.getTranslation;
var formatTranslation = I18n.formatTranslation;

const canvas = document.getElementById('gameCanvas');
const ctx = canvas.getContext('2d');

const currentActionEl = document.getElementById('currentAction');
const messageBox = document.getElementById('messageBox');
const scoreDisplayEl = document.getElementById('scoreDisplay');

// ------ Constants ------
const MAX_ELEMENTS = 21;  // Allow 21st element temporarily for merging
const BASECOLORS = [
    '#ffcccc', '#fce9cf', '#86e074', '#5fd87b',
    '#20a20f', '#81492a', '#b0bae6', '#ff0300', '#b0bae6',
    '#ff38b5', '#fadd3d', '#fc7c16', '#81b3d7', '#1b3bfa',
    '#c19cc3', '#fffa00', '#32fc03', '#d0fec5', '#a122f7',
    '#5b96be', '#b663ac', '#78cbff', '#e61a00', '#00009e',
    '#a9099e', '#b57200', '#0000af', '#b8bcbd', '#2247dd',
    '#8f9082', '#9ee474', '#7e6fa6', '#75d058', '#9aef10',
    '#7f3103', '#fabff3', '#ff0099', '#00ff27', '#67988e',
    '#00ff00', '#4cb276', '#b486b0', '#cdb0ca', '#cfb8ae',
    '#ced2ab', '#c2c4b9', '#b8bcbd', '#f31fe0', '#d781bc',
    '#9b8fb9', '#d88350', '#ada252', '#8f1f8b', '#9ba1f8',
    '#0fffb9', '#1ef02d', '#5ac44a', '#d1fd06', '#fde206',
    '#fc8e07', '#0000f5', '#fc067d', '#fb08d5', '#c004ff',
    '#7104fe', '#3106fc', '#073ffe', '#497339', '#0000e0',
    '#27fdf4', '#27fdb5', '#b4b45a', '#b79b56', '#8e8a80',
    '#b3b18e', '#c9b179', '#c9cf73', '#ccc6bf', '#feb338',
    '#d3b8cb', '#96896d', '#53535b', '#d230f8', '#0000ff',
    '#0000ff', '#ffff00', '#000000', '#6eaa59', '#659e73',
    '#26fe78', '#29fb35', '#7aa1aa', '#4d4d4d', '#4d4d4d',
    '#4d4d4d', '#4d4d4d'
];
const FRONTCOLORS = [
    '#006666', '#004488', '#7a0066', '#8a004f',
    '#c040ff', '#7fffd5', '#4d004d', '#00ffff', '#4d004d',
    '#008800', '#0033aa', '#0055cc', '#803000', '#ffd400',
    '#005588', '#ff00ff', '#004400', '#ffff66', '#66ffff',
    '#66ff66', '#663300', '#00ffff', '#00ffff', '#ffff66',
    '#00ff66', '#66ffff', '#ffff66', '#333333', '#ffdd55',
    '#e0e0ff', '#550055', '#ffff99', '#5500aa', '#550088',
    '#66ffff', '#00ff99', '#00aa55', '#aa00aa', '#ff66cc',
    '#aa00aa', '#ff66aa', '#66ff99', '#333366', '#3333aa',
    '#3333aa', '#4444aa', '#333333', '#00aa00', '#004400',
    '#ffff99', '#004488', '#333388', '#66ff66', '#ffff66',
    '#aa0066', '#aa0000', '#004488', '#0000aa', '#0000aa',
    '#0000aa', '#ffff66', '#00aa88', '#00aa44', '#44ff66',
    '#88ff66', '#ccff66', '#ffff66', '#b4d68f', '#ffff66',
    '#aa0066', '#aa0044', '#4444aa', '#333388', '#6666ff',
    '#4444ff', '#3333ff', '#3333ff', '#333333', '#0044aa',
    '#333388', '#6666cc', '#cccccc', '#00aa00', '#ffff66',
    '#ffff66', '#0000ff', '#ffff00', '#ff66ff', '#ff99cc',
    '#aa00ff', '#aa00ff', '#ffcc66', '#ffff66', '#ffff66',
    '#ffff66', '#ffff66', '#ffff66'
];

// ------ Game State ------
let state = {
    elements: [],           // { type: 'number'|'plus', value, id, angle }
    pendingElement: null,   // { type: 'number'|'plus', value } - element waiting at center
    round: 1,
    n: 0,                   // base number for new element generation, rises by 1 every 10 rounds
    gameOver: false,
    animating: false,
    nextId: 0,
    mergeFlash: [],         // indices of elements to highlight during merge (computed AFTER splice)
    hoverGapIndex: -1,      // which gap is being hovered (-1 = none)
    nextPlusRound: 2,       // next round when plus will be generated
    totalScore: 0,          // total score accumulated
    maxPlate: 0,            // largest plate value created
    needsRedraw: true,      // flag to track if canvas needs redraw
    gameStartTime: null,    // timestamp when current game started
    // Recall feature
    canRecall: true,       // whether recall button is available
    roundsSinceRecall: 25,  // rounds since last recall (starts ready)
    previousState: null,    // snapshot of state before last placement
    pendingQueue: [],        // pending elements queue (center + 2 preview)
};

// ============================================================
//  INITIALIZATION
// ============================================================
function initGame() {
    state.elements = [];
    // Start with 6 random numbers (1 or 2)
    for (let i = 0; i < 6; i++) {
        state.elements.push({
            type: 'number',
            value: Math.random() < 0.6 ? 1 : 2,
            id: state.nextId++,
            angle: (i / 6) * 2 * Math.PI - Math.PI/2
        });
    }

    state.pendingElement = null;
    state.round = 1;
    state.n = 0;
    state.gameOver = false;
    state.animating = false;
    state.mergeFlash = [];
    state.hoverGapIndex = -1;
    state.nextPlusRound = Math.floor(Math.random() * 7) + 2; // random 2-8
    state.totalScore = 0;
    state.maxPlate = 0;
    state.gameStartTime = new Date().toISOString();
    // Recall feature
    state.canRecall = true;
    state.roundsSinceRecall = 25;
    state.previousState = null;
    state.pendingQueue = [];
    // Fill pending queue with elements
    fillPendingQueue();

    updateUI();
    state.needsRedraw = true;
    messageBox.innerHTML = getTranslation('clickRingArea');
    currentActionEl.textContent = getTranslation('placeNumber');
}

// ============================================================
//  PENDING ELEMENT GENERATION
// ============================================================

function generatePendingNumber() {
    if (state.gameOver) return;
    if (state.elements.length >= MAX_ELEMENTS) {
        checkGameOver();
        return;
    }

    // n increases by 1 every 50 rounds
    state.n = Math.floor((state.round - 1) / 50);

    // Generate value in range n-2 to n+2 (no less than 1)
    const minVal = Math.max(1, state.n - 2);
    const maxVal = state.n + 2;
    const range = maxVal - minVal + 1;
    const value = minVal + Math.floor(Math.random() * range);

    state.pendingElement = {
        type: 'number',
        value: value
    };
    currentActionEl.textContent = getTranslation('placeNumber');
    state.needsRedraw = true;
}

function generatePendingPlus() {
    if (state.gameOver) return;
    if (state.elements.length >= MAX_ELEMENTS) {
        checkGameOver();
        return;
    }

    // 1/10 chance for black-golden plus, 9/10 for normal plus
    const isBlackGolden = Math.random() < 0.1;

    state.pendingElement = {
        type: 'plus',
        value: null,
        isBlackGolden: isBlackGolden
    };
    currentActionEl.textContent = isBlackGolden ? getTranslation('placeBlackPlus') : getTranslation('placePlus');
    messageBox.innerHTML = isBlackGolden ?
        getTranslation('blackPlusCenter') :
        getTranslation('plusCenter');
    state.needsRedraw = true;
}

// Generate a single element for a specific round
function generateElementForRound(forRound) {
    // Determine the n value for this round
    const n = Math.floor((forRound - 1) / 50);
    const minVal = Math.max(1, n - 2);
    const maxVal = n + 2;
    const range = maxVal - minVal + 1;
    const value = minVal + Math.floor(Math.random() * range);
    return {
        type: 'number',
        value: value,
        forRound: forRound
    };
}

// Generate a single element based on current round and plus schedule
function generateNextElement() {
    // Determine the n value for current round
    const n = Math.floor((state.round - 1) / 50);
    const minVal = Math.max(1, n - 2);
    const maxVal = n + 2;
    const range = maxVal - minVal + 1;
    const value = minVal + Math.floor(Math.random() * range);

    // Check if this round should generate a plus
    if (state.round >= state.nextPlusRound) {
        const isBlackGolden = Math.random() < 0.1;
        // Schedule next plus for 2-8 rounds later
        state.nextPlusRound = state.round + Math.floor(Math.random() * 7) + 2;
        return {
            type: 'plus',
            value: null,
            isBlackGolden: isBlackGolden
        };
    } else {
        return {
            type: 'number',
            value: value
        };
    }
}

// Fill pending queue with elements (maintains 5 total: 1 at center + 4 in queue for 3 previews)
function fillPendingQueue() {
    // Track which round number the next element should be for
    let nextRound = state.round;

    while (state.pendingQueue.length < 5) {
        // Check if this round should generate a plus
        if (nextRound >= state.nextPlusRound) {
            const isBlackGolden = Math.random() < 0.1;
            state.pendingQueue.push({
                type: 'plus',
                value: null,
                isBlackGolden: isBlackGolden
            });
            // Schedule next plus for 2-8 rounds later
            state.nextPlusRound = nextRound + Math.floor(Math.random() * 7) + 2;
        } else {
            state.pendingQueue.push(generateElementForRound(nextRound));
        }
        nextRound++;
    }

    // Set pendingElement to first in queue if not set
    if (!state.pendingElement) {
        state.pendingElement = state.pendingQueue.shift();
        updateCurrentActionText();
    }
    state.needsRedraw = true;
}

// Get next element from queue (call when center element is placed)
function getNextFromQueue() {
    if (state.pendingQueue.length > 0) {
        state.pendingElement = state.pendingQueue.shift();
    } else {
        state.pendingElement = generateNextElement();
    }
    // Refill queue to maintain 3 elements
    fillPendingQueue();
    state.needsRedraw = true;

    updateCurrentActionText();
}

function updateCurrentActionText() {
    if (state.pendingElement) {
        if (state.pendingElement.type === 'number') {
            currentActionEl.textContent = getTranslation('placeNumber');
        } else {
            currentActionEl.textContent = state.pendingElement.isBlackGolden ?
                getTranslation('placeBlackPlus') : getTranslation('placePlus');
        }
    }
}

// ============================================================
//  CORE FUNCTIONS
// ============================================================

// Redistribute elements evenly on the ring
function redistributeElements() {
    const count = state.elements.length;
    if (count === 0) return;
    const step = (2 * Math.PI) / count;
    const startAngle = -Math.PI / 2;
    state.elements.forEach((el, index) => {
        el.angle = startAngle + index * step;
    });
}

// Find which gap was clicked (based on angle)
function getGapIndex(clickAngle) {
    const len = state.elements.length;
    if (len === 0) return 0;
    if (len === 1) return 1;

    // Normalize click angle to [0, 2π)
    let targetAngle = clickAngle % (2 * Math.PI);
    if (targetAngle < 0) targetAngle += 2 * Math.PI;

    // Normalize all element angles to [0, 2π)
    const normalizedAngles = state.elements.map(el => {
        let angle = el.angle % (2 * Math.PI);
        if (angle < 0) angle += 2 * Math.PI;
        return angle;
    });

    // Find the gap that contains the target angle
    for (let i = 0; i < len; i++) {
        const currentAngle = normalizedAngles[i];
        const nextAngle = normalizedAngles[(i + 1) % len];

        // Calculate the midpoint of the gap
        let gapMidpoint;
        if (nextAngle > currentAngle) {
            // Normal case: gap doesn't cross 0
            gapMidpoint = (currentAngle + nextAngle) / 2;
        } else {
            // Gap crosses 0: nextAngle < currentAngle
            // The midpoint is at (currentAngle + nextAngle + 2π) / 2
            gapMidpoint = (currentAngle + nextAngle + 2 * Math.PI) / 2;
            if (gapMidpoint >= 2 * Math.PI) {
                gapMidpoint -= 2 * Math.PI;
            }
        }

        // Check if target angle is closer to this gap's midpoint than to adjacent gaps
        let prevAngle = normalizedAngles[(i - 1 + len) % len];
        let nextNextAngle = normalizedAngles[(i + 2) % len];

        // Calculate boundaries for this gap
        let lowerBound, upperBound;

        if (nextAngle > currentAngle) {
            // Gap doesn't cross 0
            lowerBound = currentAngle;
            upperBound = nextAngle;
        } else {
            // Gap crosses 0
            if (targetAngle >= currentAngle || targetAngle <= nextAngle) {
                return i + 1;
            } else {
                continue;
            }
        }

        if (targetAngle >= lowerBound && targetAngle <= upperBound) {
            return i + 1;
        }
    }

    return len;
}

// Check game over
function checkGameOver() {
    if (state.gameOver) return true;

    if (state.elements.length >= MAX_ELEMENTS) {
        const hasPlusMerge = checkPlusMerge();

        if (!hasPlusMerge) {
            state.gameOver = true;
            state.pendingElement = null;

            messageBox.innerHTML = `${getTranslation('gameOver')}! ${getTranslation('diskFull')}<br>${getTranslation('score')}: ${state.totalScore} | ${getTranslation('maxPlate')}: ${state.maxPlate}`;
            currentActionEl.textContent = getTranslation('gameOver');
            startGameOverAnimation();
            return true;
        }
    }
    return false;
}

// Check if plus can merge (same number on both sides for normal plus, any two numbers for black-golden plus)
function checkPlusMerge() {
    const len = state.elements.length;
    if (len < 3) return false;

    const plusIndices = [];
    state.elements.forEach((el, idx) => {
        if (el.type === 'plus') plusIndices.push(idx);
    });

    for (const idx of plusIndices) {
        const leftIdx = (idx - 1 + len) % len;
        const rightIdx = (idx + 1) % len;

        const left = state.elements[leftIdx];
        const right = state.elements[rightIdx];
        const plus = state.elements[idx];

        if (left.type === 'number' && right.type === 'number') {
            // Black-golden plus: combines any two numbers
            // Normal plus: combines only same numbers
            if (plus.isBlackGolden || left.value === right.value) {
                executePlusMerge(idx, leftIdx, rightIdx);
                return true;
            }
        }
    }
    return false;
}

// Execute merge triggered by plus
function executePlusMerge(plusIdx, leftIdx, rightIdx) {
    const left = state.elements[leftIdx];
    const right = state.elements[rightIdx];
    // Take the larger value and add 1
    const newVal = Math.max(left.value, right.value) + 1;

    // Add score: sum of values of all elements being merged (two numbers)
    state.totalScore += left.value + right.value;

    // Update max plate if needed
    if (newVal > state.maxPlate) {
        state.maxPlate = newVal;
    }

    // Remove plus and both numbers (from back to front)
    const indices = [plusIdx, leftIdx, rightIdx].sort((a, b) => b - a);
    for (const idx of indices) {
        state.elements.splice(idx, 1);
    }

    // Insert merged number at the position
    const insertPos = Math.min(leftIdx, rightIdx);

    // Calculate the target angle for the merged element
    const len = state.elements.length;
    const step = (2 * Math.PI) / len;
    const startAngle = -Math.PI / 2;
    const targetAngle = startAngle + insertPos * step;

    const newElement = {
        type: 'number',
        value: newVal,
        id: state.nextId++,
        angle: targetAngle,
        isAnimating: false,
        animProgress: 0,
        newlyFormed: true
    };
    state.elements.splice(insertPos, 0, newElement);

    // Set merge flash to highlight new element + its two neighbors (indices valid after splice)
    const nlen = state.elements.length;
    state.mergeFlash = [
        (insertPos - 1 + nlen) % nlen,
        insertPos,
        (insertPos + 1) % nlen
    ];

    // Store current angles of all elements for animation
    const oldAngles = state.elements.map(el => el.angle);

    // Redistribute to get new target angles
    redistributeElements();

    // Set up animation for all old elements (except the new one)
    state.elements.forEach((el, idx) => {
        if (idx !== insertPos) {
            el.startAngle = oldAngles[idx];
            el.targetAngle = state.elements[idx].angle;
            el.isAnimating = true;
            el.animProgress = 0;
            el.angle = el.startAngle;
        }
    });

    state.round++;
    state.animating = true;

    animateRedistribution();

    setTimeout(() => {
        state.mergeFlash = [];
        if (checkGameOver()) return;
        performChainMergeStep();
    }, 500);  // Reduced from 700 for faster animation
}

// Stepwise chain merge - one merge at a time with animation
function performChainMergeStep() {
    // Find the newly formed element
    let centerIdx = -1;
    for (let i = 0; i < state.elements.length; i++) {
        if (state.elements[i].newlyFormed) {
            centerIdx = i;
            break;
        }
    }

    if (centerIdx === -1) {
        // No more chain merges possible, check for plus merges
        setTimeout(() => {
            if (checkGameOver()) return;
            const hasMore = checkPlusMerge();
            if (!hasMore) {
                state.animating = false;
                updateUI();
                state.needsRedraw = true;
                messageBox.innerHTML = formatTranslation('mergeComplete', {round: state.round-1});
            }
        }, 300);
        return;
    }

    const len = state.elements.length;
    if (len < 3) {
        state.elements.forEach(el => el.newlyFormed = false);
        setTimeout(() => {
            if (checkGameOver()) return;
            const hasMore = checkPlusMerge();
            if (!hasMore) {
                state.animating = false;
                updateUI();
                state.needsRedraw = true;
                messageBox.innerHTML = formatTranslation('mergeComplete', {round: state.round-1});
                if (state.elements.length < MAX_ELEMENTS) {
                    getNextFromQueue();
                }
            }
        }, 300);
        return;
    }

    const leftIdx = (centerIdx - 1 + len) % len;
    const rightIdx = (centerIdx + 1) % len;

    const left = state.elements[leftIdx];
    const center = state.elements[centerIdx];
    const right = state.elements[rightIdx];

    // Check if left and right have the same value (palindrome pattern)
    if (left.type === 'number' && right.type === 'number' &&
        left.value === right.value && center.type === 'number') {

        // Merge: left + center + right → center+1
        const newVal = center.value + 1;

        // Add score: sum of values of all elements being merged (three numbers)
        state.totalScore += left.value + center.value + right.value;

        // Update max plate if needed
        if (newVal > state.maxPlate) {
            state.maxPlate = newVal;
        }

        // Remove left, center, right (from back to front)
        const indices = [leftIdx, centerIdx, rightIdx].sort((a, b) => b - a);
        for (const idx of indices) {
            state.elements.splice(idx, 1);
        }

        // Insert merged element at the position
        const insertPos = Math.min(leftIdx, centerIdx, rightIdx);

        // Calculate target angle
        const newLen = state.elements.length;
        const step = (2 * Math.PI) / newLen;
        const startAngle = -Math.PI / 2;
        const targetAngle = startAngle + insertPos * step;

        const newEl = {
            type: 'number',
            value: newVal,
            id: state.nextId++,
            angle: targetAngle,
            isAnimating: false,
            animProgress: 0,
            newlyFormed: true  // Keep flag for potential further merges
        };
        state.elements.splice(insertPos, 0, newEl);

        // Set merge flash to highlight new element + its two neighbors (indices valid after splice)
        const flashLen = state.elements.length;
        state.mergeFlash = [
            (insertPos - 1 + flashLen) % flashLen,
            insertPos,
            (insertPos + 1) % flashLen
        ];

        // Store current angles for animation
        const oldAngles = state.elements.map(el => el.angle);

        // Redistribute
        redistributeElements();

        // Set up animation for all old elements
        state.elements.forEach((el, idx) => {
            if (idx !== insertPos) {
                el.startAngle = oldAngles[idx];
                el.targetAngle = state.elements[idx].angle;
                el.isAnimating = true;
                el.animProgress = 0;
                el.angle = el.startAngle;
            }
        });

        state.animating = true;
        animateRedistribution();

        // After animation, check for next chain merge
        setTimeout(() => {
            state.mergeFlash = [];
            if (checkGameOver()) return;
            performChainMergeStep();
        }, 400);
    } else {
        // No more chain merges possible from this center
        state.elements.forEach(el => el.newlyFormed = false);
        setTimeout(() => {
            if (checkGameOver()) return;
            const hasMore = checkPlusMerge();
            if (!hasMore) {
                state.animating = false;
                updateUI();
                state.needsRedraw = true;
                messageBox.innerHTML = formatTranslation('mergeComplete', {round: state.round-1});
                if (state.elements.length < MAX_ELEMENTS) {
                    getNextFromQueue();
                }
            }
        }, 300);
    }
}

// ============================================================
//  PLACE ELEMENTS
// ============================================================

function placeElementFromCenter(gapIndex) {
    if (state.gameOver || state.animating) return false;
    if (!state.pendingElement) {
        messageBox.innerHTML = getTranslation('noElementWaiting');
        return false;
    }

    const len = state.elements.length;
    if (len >= MAX_ELEMENTS + 1) {
        checkGameOver();
        return false;
    }

    // Save state for recall (before placing)
    state.previousState = {
        elements: JSON.parse(JSON.stringify(state.elements)),
        round: state.round,
        n: state.n,
        totalScore: state.totalScore,
        maxPlate: state.maxPlate,
        pendingElement: state.pendingElement ? JSON.parse(JSON.stringify(state.pendingElement)) : null,
        pendingQueue: JSON.parse(JSON.stringify(state.pendingQueue)),
        nextPlusRound: state.nextPlusRound,
        canRecall: state.canRecall,
        roundsSinceRecall: state.roundsSinceRecall
    };

    const pending = state.pendingElement;

    // Calculate the target angle for the new element before inserting
    const targetAngle = calculateTargetAngle(gapIndex, len);

    const newElement = {
        type: pending.type,
        value: pending.value,
        id: state.nextId++,
        angle: 0,  // Start from center
        isAnimating: true,
        animProgress: 0,
        startAngle: 0,
        targetAngle: targetAngle,
        isNew: true,
        isBlackGolden: pending.isBlackGolden || false
    };

    // Insert at gap - handle edge case where gapIndex equals length
    const insertPos = gapIndex >= len ? len : gapIndex;

    if (insertPos >= len) {
        state.elements.push(newElement);
    } else {
        state.elements.splice(insertPos, 0, newElement);
    }

    // Store current angles of all elements for animation
    const oldAngles = state.elements.map(el => el.angle);

    // Redistribute to get new target angles
    redistributeElements();

    // Set up animation for all old elements
    state.elements.forEach((el, idx) => {
        if (idx !== insertPos) {
            el.startAngle = oldAngles[idx];
            el.targetAngle = state.elements[idx].angle;
            el.isAnimating = true;
            el.animProgress = 0;
            el.angle = el.startAngle;
            el.isNew = false;
        }
    });

    // Clear pending element
    state.pendingElement = null;
    state.round++;
    state.roundsSinceRecall++;
    console.log('PLACEMENT via placeElementFromCenter: round=' + state.round + ', roundsSinceRecall=' + state.roundsSinceRecall + ', previousState=' + (state.previousState !== null));
    state.animating = true;

    animateRedistribution();

    setTimeout(() => {
        const hasMerge = checkPlusMerge();
        if (!hasMerge) {
            state.animating = false;
            updateUI();
            state.needsRedraw = true;

            if (newElement.type === 'number') {
                messageBox.innerHTML = formatTranslation('numberPlaced', {pos: insertPos + 1, round: state.round-1});
                if (state.elements.length < MAX_ELEMENTS) {
                    getNextFromQueue();
                }
            } else {
                const plusType = newElement.isBlackGolden ? 'Black+' : 'Plus';
                messageBox.innerHTML = formatTranslation('plusPlaced', {type: plusType});
                if (!checkPlusMerge()) {
                    setTimeout(() => {
                        if (state.elements.length < MAX_ELEMENTS) {
                            getNextFromQueue();
                        }
                    }, 500);
                }
            }
        }
    }, 600);

    checkGameOver();
    updateUI();
    return true;
}

// Recall last move
function recallLastMove() {
    console.log('Recall attempt: canRecall=', state.canRecall, 'previousState=', state.previousState !== null, 'animating=', state.animating, 'gameOver=', state.gameOver, 'roundsSinceRecall=', state.roundsSinceRecall);
    if (!state.canRecall) {
        messageBox.innerHTML = getTranslation('recallNotAvailableYet');
        return;
    }
    if (!state.previousState) {
        messageBox.innerHTML = getTranslation('noMoveToRecall');
        return;
    }
    if (state.animating) {
        messageBox.innerHTML = getTranslation('cannotRecallDuringAnimation');
        return;
    }
    if (state.gameOver) {
        messageBox.innerHTML = getTranslation('gameOver');
        return;
    }

    const prev = state.previousState;

    // Restore state
    state.elements = prev.elements;
    state.round = prev.round;
    state.n = prev.n;
    state.totalScore = prev.totalScore;
    state.maxPlate = prev.maxPlate;
    state.pendingElement = prev.pendingElement;
    state.pendingQueue = prev.pendingQueue;
    state.nextPlusRound = prev.nextPlusRound;
    state.canRecall = false;
    state.roundsSinceRecall = 0;
    state.previousState = null;

    // Update UI
    updateUI();
    state.needsRedraw = true;
    messageBox.innerHTML = getTranslation('moveRecalled');
    if (state.pendingElement) {
        if (state.pendingElement.type === 'number') {
            currentActionEl.textContent = getTranslation('placeNumber');
        } else {
            currentActionEl.textContent = state.pendingElement.isBlackGolden ?
                getTranslation('placeBlackPlus') : getTranslation('placePlus');
        }
    }
}

// Calculate the target angle for a new element at the specified gap
function calculateTargetAngle(gapIndex, currentLen) {
    const step = (2 * Math.PI) / (currentLen + 1);
    const startAngle = -Math.PI / 2;
    return startAngle + gapIndex * step;
}

// ============================================================
//  ANIMATION
// ============================================================

function animateElementFromCenter(index) {
    const el = state.elements[index];
    if (!el || !el.isAnimating) return;

    el.animProgress += 0.05;
    if (el.animProgress >= 1) {
        el.animProgress = 1;
        el.angle = el.targetAngle;
        el.isAnimating = false;
        state.animating = false;
        state.needsRedraw = true;
        return;
    }

    const progress = 1 - Math.pow(1 - el.animProgress, 3);
    el.angle = el.targetAngle * progress;

    state.needsRedraw = true;
    requestAnimationFrame(() => animateElementFromCenter(index));
}

function animateRedistribution() {
    let allDone = true;

    state.elements.forEach(el => {
        if (el.isAnimating) {
            allDone = false;
            el.animProgress += 0.12;  // Increased from 0.05 for faster animation

            if (el.animProgress >= 1) {
                el.animProgress = 1;
                el.angle = el.targetAngle;
                el.isAnimating = false;
                el.startAngle = null;
                el.isNew = false;
            } else {
                const progress = 1 - Math.pow(1 - el.animProgress, 3);
                if (el.isNew) {
                    // New element: move from center to target angle
                    el.angle = el.targetAngle * progress;
                } else {
                    // Old element: move from startAngle to targetAngle via shortest path
                    let diff = el.targetAngle - el.startAngle;
                    while (diff > Math.PI) diff -= 2 * Math.PI;
                    while (diff < -Math.PI) diff += 2 * Math.PI;
                    el.angle = el.startAngle + diff * progress;
                }
            }
        }
    });

    state.needsRedraw = true;

    if (!allDone) {
        requestAnimationFrame(animateRedistribution);
    } else {
        state.animating = false;
    }
}

// ============================================================
//  CLICK HANDLER
// ============================================================

function handleCanvasClick(e) {
    if (state.gameOver || state.animating) {
        if (state.gameOver) messageBox.innerHTML = `${getTranslation('gameOver')}, ${getTranslation('clickRingArea')}`;
        return;
    }

    if (!state.pendingElement) {
        messageBox.innerHTML = getTranslation('waiting');
        return;
    }

    const rect = canvas.getBoundingClientRect();
    const scaleX = canvas.width / rect.width;
    const scaleY = canvas.height / rect.height;

    const clientX = e.clientX || e.touches?.[0]?.clientX || 0;
    const clientY = e.clientY || e.touches?.[0]?.clientY || 0;

    const canvasX = (clientX - rect.left) * scaleX;
    const canvasY = (clientY - rect.top) * scaleY;

    const cx = canvas.width / 2;
    const cy = canvas.height / 2;
    const dx = canvasX - cx;
    const dy = canvasY - cy;
    const dist = Math.sqrt(dx*dx + dy*dy);
    const radius = canvas.width * 0.38;

    // Click must be on the ring area
    const innerRadius = radius * 0.6;
    const outerRadius = radius * 1.15;

    if (dist < innerRadius || dist > outerRadius) {
        messageBox.innerHTML = getTranslation('clickOnRing');
        return;
    }

    let angle = Math.atan2(dy, dx);
    if (angle < 0) angle += 2 * Math.PI;

    const len = state.elements.length;
    if (len === 0) {
        // Empty disk, place first element
        const pending = state.pendingElement;
        state.elements.push({
            type: pending.type,
            value: pending.value,
            id: state.nextId++,
            angle: 0,
            isAnimating: false,
            animProgress: 0
        });
        state.pendingElement = null;
        redistributeElements();
        state.round++;
        state.roundsSinceRecall++;
        console.log('PLACEMENT: round=' + state.round + ', roundsSinceRecall=' + state.roundsSinceRecall + ', previousState=' + (state.previousState !== null));
        updateUI();
        state.needsRedraw = true;
        messageBox.innerHTML = getTranslation('firstElementPlaced');
        getNextFromQueue();
        return;
    }

    const gapIndex = getGapIndex(angle);
    placeElementFromCenter(gapIndex);
}

function handleCanvasMouseMove(e) {
    if (state.gameOver || state.animating || !state.pendingElement) {
        state.hoverGapIndex = -1;
        return;
    }

    const rect = canvas.getBoundingClientRect();
    const scaleX = canvas.width / rect.width;
    const scaleY = canvas.height / rect.height;

    const clientX = e.clientX || 0;
    const clientY = e.clientY || 0;

    const canvasX = (clientX - rect.left) * scaleX;
    const canvasY = (clientY - rect.top) * scaleY;

    const cx = canvas.width / 2;
    const cy = canvas.height / 2;
    const dx = canvasX - cx;
    const dy = canvasY - cy;
    const dist = Math.sqrt(dx*dx + dy*dy);
    const radius = canvas.width * 0.38;

    // Check if mouse is on the ring area
    const innerRadius = radius * 0.6;
    const outerRadius = radius * 1.15;

    if (dist < innerRadius || dist > outerRadius) {
        state.hoverGapIndex = -1;
        state.needsRedraw = true;
        return;
    }

    let angle = Math.atan2(dy, dx);
    if (angle < 0) angle += 2 * Math.PI;

    const len = state.elements.length;
    if (len === 0) {
        state.hoverGapIndex = 0;
        state.needsRedraw = true;
        return;
    }

    state.hoverGapIndex = getGapIndex(angle);
    state.needsRedraw = true;
}

function handleCanvasMouseLeave() {
    state.hoverGapIndex = -1;
    state.needsRedraw = true;
}

// ============================================================
//  DRAWING
// ============================================================

function drawCanvas() {
    const w = canvas.width, h = canvas.height;
    ctx.clearRect(0, 0, w, h);
    const cx = w/2, cy = h/2;
    const radius = w * 0.35;  // Reduced from 0.38
    const dotRadius = w * 0.045;  // Reduced from 0.055

    // Draw ring
    ctx.beginPath();
    ctx.arc(cx, cy, radius, 0, 2 * Math.PI);
    ctx.strokeStyle = '#3c6080';
    ctx.lineWidth = 3;  // Reduced from 4
    ctx.stroke();

    // Draw clickable ring indicators
    const innerRadius = radius * 0.65;  // Increased from 0.6
    const outerRadius = radius * 1.1;  // Reduced from 1.15
    ctx.beginPath();
    ctx.arc(cx, cy, outerRadius, 0, 2 * Math.PI);
    ctx.strokeStyle = 'rgba(60, 96, 128, 0.15)';
    ctx.lineWidth = 2;
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(cx, cy, innerRadius, 0, 2 * Math.PI);
    ctx.strokeStyle = 'rgba(60, 96, 128, 0.15)';
    ctx.lineWidth = 2;
    ctx.stroke();

    // Draw connecting lines
    if (state.elements.length > 1) {
        ctx.beginPath();
        state.elements.forEach((el, idx) => {
            const x = cx + radius * Math.cos(el.angle);
            const y = cy + radius * Math.sin(el.angle);
            if (idx === 0) ctx.moveTo(x, y);
            else ctx.lineTo(x, y);
        });
        const first = state.elements[0];
        const x = cx + radius * Math.cos(first.angle);
        const y = cy + radius * Math.sin(first.angle);
        ctx.lineTo(x, y);
        ctx.strokeStyle = 'rgba(60, 96, 128, 0.3)';
        ctx.lineWidth = 2;
        ctx.stroke();
    }

    // Draw elements on ring
    state.elements.forEach((el, idx) => {
        const progress = el.isAnimating ? (el.animProgress || 0) : 1;
        const scale = el.isAnimating ? 0.6 + 0.4 * progress : 1;

        // New element animates from center to ring position
        const drawRadius = el.isNew ? radius * progress : radius;
        const x = cx + drawRadius * Math.cos(el.angle);
        const y = cy + drawRadius * Math.sin(el.angle);

        if (el.type === 'number') {
            const colorIndex = (el.value - 1) % BASECOLORS.length;
            const baseColor = BASECOLORS[colorIndex];
            const frontColor = FRONTCOLORS[colorIndex];

            ctx.shadowColor = baseColor;
            ctx.shadowBlur = 10;  // Reduced from 12
            ctx.beginPath();
            ctx.arc(x, y, dotRadius * 1.2 * scale, 0, 2 * Math.PI);  // Reduced from 1.3
            ctx.fillStyle = baseColor;
            ctx.fill();
            ctx.shadowBlur = 0;

            ctx.fillStyle = frontColor;
            ctx.font = `600 ${w * 0.06 * scale}px 'Bahnschrift SemiCondensed', 'Cascadia Code', 'Segoe UI', sans-serif`;
            ctx.textAlign = 'center';
            ctx.textBaseline = 'middle';
            ctx.fillText(el.value, x, y);  // Removed the -1 offset to center properly
        } else {
            // Plus element
            if (el.isBlackGolden) {
                // Black-golden plus
                ctx.shadowColor = '#ffd700';
                ctx.shadowBlur = 20;  // Reduced from 25
                ctx.beginPath();
                ctx.arc(x, y, dotRadius * 1.2 * scale, 0, 2 * Math.PI);  // Reduced from 1.3
                ctx.fillStyle = '#1a1a1a';
                ctx.fill();
                ctx.shadowBlur = 0;

                // Golden border
                ctx.strokeStyle = '#ffd700';
                ctx.lineWidth = 2;
                ctx.stroke();

                ctx.fillStyle = '#ffd700';
                ctx.font = `600 ${w * 0.07 * scale}px 'Bahnschrift SemiCondensed', 'Cascadia Code', 'Segoe UI', sans-serif`;
                ctx.textAlign = 'center';
                ctx.textBaseline = 'middle';
                ctx.fillText('+', x, y);
            } else {
                // Normal plus
                ctx.shadowColor = '#ffd700';
                ctx.shadowBlur = 15;  // Reduced from 20
                ctx.beginPath();
                ctx.arc(x, y, dotRadius * 1.2 * scale, 0, 2 * Math.PI);  // Reduced from 1.3
                ctx.fillStyle = '#ffd700';
                ctx.fill();
                ctx.shadowBlur = 0;

                ctx.fillStyle = '#1e2f44';
                ctx.font = `600 ${w * 0.07 * scale}px 'Bahnschrift SemiCondensed', 'Cascadia Code', 'Segoe UI', sans-serif`;
                ctx.textAlign = 'center';
                ctx.textBaseline = 'middle';
                ctx.fillText('+', x, y);
            }
        }
    });

    // Draw merge flash circles on current elements (outside elements loop)
    state.mergeFlash.forEach(idx => {
        const el = state.elements[idx];
        if (!el) return;
        const fx = cx + radius * Math.cos(el.angle);
        const fy = cy + radius * Math.sin(el.angle);
        ctx.shadowColor = '#ffd700';
        ctx.shadowBlur = 25;
        ctx.beginPath();
        ctx.arc(fx, fy, dotRadius * 1.8, 0, 2 * Math.PI);
        ctx.strokeStyle = 'rgba(255, 215, 0, 0.6)';
        ctx.lineWidth = 3;
        ctx.stroke();
        ctx.shadowBlur = 0;
    });

    // Draw hover indicator for gap selection
    if (state.hoverGapIndex >= 0 && state.pendingElement && !state.animating && !state.gameOver) {
        const len = state.elements.length;
        const hoverIndex = state.hoverGapIndex >= len ? len : state.hoverGapIndex;

        // Calculate the angle for the hovered gap
        let hoverAngle;
        if (len === 0) {
            hoverAngle = 0;
        } else {
            // Get the angles of adjacent elements
            const prevIndex = (hoverIndex - 1 + len) % len;
            const nextIndex = hoverIndex % len;

            let prevAngle = state.elements[prevIndex].angle % (2 * Math.PI);
            if (prevAngle < 0) prevAngle += 2 * Math.PI;
            let nextAngle = state.elements[nextIndex].angle % (2 * Math.PI);
            if (nextAngle < 0) nextAngle += 2 * Math.PI;

            // Calculate midpoint of the gap
            if (nextAngle > prevAngle) {
                hoverAngle = (prevAngle + nextAngle) / 2;
            } else {
                // Gap crosses 0
                hoverAngle = (prevAngle + nextAngle + 2 * Math.PI) / 2;
                if (hoverAngle >= 2 * Math.PI) {
                    hoverAngle -= 2 * Math.PI;
                }
            }
        }

        const hoverX = cx + radius * Math.cos(hoverAngle);
        const hoverY = cy + radius * Math.sin(hoverAngle);

        // Draw indicator
        ctx.shadowColor = '#00ff88';
        ctx.shadowBlur = 20;
        ctx.beginPath();
        ctx.arc(hoverX, hoverY, dotRadius * 1.8, 0, 2 * Math.PI);
        ctx.strokeStyle = 'rgba(0, 255, 136, 0.8)';
        ctx.lineWidth = 3;
        ctx.stroke();
        ctx.shadowBlur = 0;

        // Draw small arrow pointing to center
        ctx.beginPath();
        ctx.moveTo(hoverX, hoverY);
        const arrowX = cx + radius * 0.8 * Math.cos(hoverAngle);
        const arrowY = cy + radius * 0.8 * Math.sin(hoverAngle);
        ctx.lineTo(arrowX, arrowY);
        ctx.strokeStyle = 'rgba(0, 255, 136, 0.4)';
        ctx.lineWidth = 2;
        ctx.stroke();
    }

    // ============================================================
    //  CENTER DISPLAY - FIXED!
    // ============================================================
    if (state.pendingElement) {
        // Show waiting element at center with pulse animation
        const pulse = Math.sin(Date.now() / 400) * 0.2 + 0.8;
        const scale = pulse;

        if (state.pendingElement.type === 'number') {
            // Show number at center
            const value = state.pendingElement.value;
            const colorIndex = (value - 1) % BASECOLORS.length;
            const baseColor = BASECOLORS[colorIndex];
            const frontColor = FRONTCOLORS[colorIndex];

            // Glow effect
            ctx.shadowColor = baseColor;
            ctx.shadowBlur = 40 * pulse;

            // Circle
            const size = w * 0.1 * scale;
            ctx.beginPath();
            ctx.arc(cx, cy, size, 0, 2 * Math.PI);
            ctx.fillStyle = baseColor;
            ctx.fill();
            ctx.shadowBlur = 0;

            // Number text
            ctx.fillStyle = frontColor;
            ctx.font = `600 ${w * 0.10 * scale}px 'Bahnschrift SemiCondensed', 'Cascadia Code', 'Segoe UI', sans-serif`;
            ctx.textAlign = 'center';
            ctx.textBaseline = 'middle';
            ctx.fillText(value, cx, cy);  // Removed -1 offset to center properly

            // Label
            ctx.fillStyle = 'rgba(255,255,255,0.3)';
            ctx.font = `${w * 0.035}px 'Bahnschrift Light', 'Cascadia Code', 'Segoe UI', sans-serif`;
            ctx.fillText(getTranslation('placeMe'), cx, cy + size + w * 0.035);

        } else {
            // Show plus at center
            ctx.shadowColor = '#ffd700';
            ctx.shadowBlur = 40 * pulse;

            const size = w * 0.1 * scale;
            ctx.beginPath();
            ctx.arc(cx, cy, size, 0, 2 * Math.PI);

            if (state.pendingElement.isBlackGolden) {
                // Black-golden plus
                ctx.fillStyle = '#1a1a1a';
                ctx.fill();
                ctx.shadowBlur = 0;

                // Golden border
                ctx.strokeStyle = '#ffd700';
                ctx.lineWidth = 2;
                ctx.stroke();

                ctx.fillStyle = '#ffd700';
                ctx.font = `600 ${w * 0.10 * scale}px 'Bahnschrift SemiCondensed', 'Cascadia Code', 'Segoe UI', sans-serif`;
                ctx.textAlign = 'center';
                ctx.textBaseline = 'middle';
                ctx.fillText('+', cx, cy);

                ctx.fillStyle = 'rgba(255,215,0,0.3)';
                ctx.font = `${w * 0.035}px 'Bahnschrift Light', 'Cascadia Code', 'Segoe UI', sans-serif`;
                ctx.fillText(getTranslation('placeMe'), cx, cy + size + w * 0.035);
            } else {
                // Normal plus
                ctx.fillStyle = '#ffd700';
                ctx.fill();
                ctx.shadowBlur = 0;

                ctx.fillStyle = '#1e2f44';
                ctx.font = `600 ${w * 0.10 * scale}px 'Bahnschrift SemiCondensed', 'Cascadia Code', 'Segoe UI', sans-serif`;
                ctx.textAlign = 'center';
                ctx.textBaseline = 'middle';
                ctx.fillText('+', cx, cy);

                ctx.fillStyle = 'rgba(255,215,0,0.3)';
                ctx.font = `${w * 0.035}px 'Bahnschrift Light', 'Cascadia Code', 'Segoe UI', sans-serif`;
                ctx.fillText(getTranslation('placeMe'), cx, cy + size + w * 0.035);
            }
        }
    } else if (state.elements.length > 0 && !state.animating) {
        // Empty center - show subtle dot
        ctx.fillStyle = 'rgba(86, 125, 159, 0.15)';
        ctx.beginPath();
        ctx.arc(cx, cy, w * 0.03, 0, 2 * Math.PI);
        ctx.fill();
    }

    // Game over overlay with animation
    if (state.gameOver) {
        const progress = Math.min(gameOverAnimProgress, 1);
        const easeProgress = 1 - Math.pow(1 - progress, 3);

        ctx.fillStyle = `rgba(0,0,0,${0.6 * easeProgress})`;
        ctx.beginPath();
        ctx.arc(cx, cy, radius + 10 * easeProgress, 0, 2 * Math.PI);
        ctx.fill();

        ctx.fillStyle = '#ffb3b3';
        ctx.font = `700 ${w * 0.10}px 'Bahnschrift Condensed', 'Cascadia Code', 'Segoe UI', sans-serif`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';

        ctx.globalAlpha = easeProgress;
        ctx.fillText('GAME OVER', cx, cy);
        ctx.globalAlpha = 1;
    }
}

// ============================================================
//  UI UPDATE
// ============================================================

function updateUI() {
    if (scoreDisplayEl) {
        scoreDisplayEl.textContent = state.totalScore;
    }

    const maxNumberDisplay = document.getElementById('maxNumberDisplay');
    if (maxNumberDisplay) {
        maxNumberDisplay.textContent = state.maxPlate;
    }

    updateWarningLights();
    updatePendingPreview();
    updateRecallButton();

    if (state.pendingElement) {
        if (state.pendingElement.type === 'plus') {
            currentActionEl.textContent = state.pendingElement.isBlackGolden ? getTranslation('placeBlackPlus') : getTranslation('placePlus');
        } else {
            currentActionEl.textContent = getTranslation('placeNumber');
        }
    } else {
        currentActionEl.textContent = getTranslation('waiting');
    }
}

function updatePendingPreview() {
    const ball1 = document.getElementById('pendingBall1');
    const ball2 = document.getElementById('pendingBall2');
    const ball3 = document.getElementById('pendingBall3');

    // Show 3 upcoming balls (indices 0, 1, 2 of queue)
    const balls = [ball1, ball2, ball3];

    for (let i = 0; i < 3; i++) {
        const ball = balls[i];
        if (state.pendingQueue.length > i) {
            const elem = state.pendingQueue[i];
            if (elem.type === 'number') {
                const colorIndex = (elem.value - 1) % BASECOLORS.length;
                ball.style.background = BASECOLORS[colorIndex];
                ball.style.color = FRONTCOLORS[colorIndex];
                ball.style.border = '';
                ball.textContent = elem.value;
                ball.className = 'atamas-pending-ball number';
            } else {
                if (elem.isBlackGolden) {
                    ball.style.background = '#1a1a1a';
                    ball.style.color = '#ffd700';
                    ball.style.border = '2px solid #ffd700';
                } else {
                    ball.style.background = '#ffd700';
                    ball.style.color = '#1e2f44';
                    ball.style.border = '';
                }
                ball.textContent = '+';
                ball.className = 'atamas-pending-ball plus';
            }
        } else {
            ball.textContent = '?';
            ball.style.background = 'rgba(60, 96, 128, 0.3)';
            ball.style.color = 'rgba(255,255,255,0.3)';
            ball.style.border = '';
            ball.className = 'atamas-pending-ball empty';
        }
    }
}

function updateRecallButton() {
    const recallBtn = document.getElementById('recallBtn');
    if (!recallBtn) return;

    const roundsLeft = 25 - state.roundsSinceRecall;
    const cooldownComplete = state.roundsSinceRecall >= 25;
    const hasStateToRecall = state.previousState !== null;

    console.log('Recall state:', { roundsSinceRecall: state.roundsSinceRecall, cooldownComplete, hasStateToRecall, canRecall: state.canRecall });

    if (cooldownComplete && !state.canRecall) {
        state.canRecall = true;
    }

    // Recall is available when cooldown is complete AND we have a state to recall
    if (cooldownComplete && hasStateToRecall) {
        recallBtn.disabled = false;
        recallBtn.textContent = getTranslation('recall') || '↩ Recall';
        recallBtn.title = 'Recall last move';
    } else if (cooldownComplete) {
        // Cooldown complete but nothing to recall yet
        recallBtn.disabled = true;
        recallBtn.textContent = `↩ ${roundsLeft}`;
        recallBtn.title = 'Place an element first';
    } else {
        recallBtn.disabled = true;
        recallBtn.textContent = `↩ ${roundsLeft}`;
        recallBtn.title = formatTranslation('recallCooldown', {n: roundsLeft});
    }
}

function updateWarningLights() {
    const lights = document.querySelectorAll('.atamas-warning-dot');
    const elementCount = state.elements.length;

    lights.forEach((light, index) => {
        light.className = 'atamas-warning-dot';

        if (elementCount >= 18) {
            if (elementCount <= 18) {
                if (index < 3) light.classList.add('green');
            } else if (elementCount <= 19) {
                if (index < 2) light.classList.add('yellow');
            } else {
                if (index < 1) light.classList.add('red');
            }
        }
    });
}

// ============================================================
//  GAME OVER ANIMATION
// ============================================================

let gameOverAnimProgress = 0;
let gameOverAnimationId = null;

function startGameOverAnimation() {
    gameOverAnimProgress = 0;
    if (gameOverAnimationId) cancelAnimationFrame(gameOverAnimationId);
    animateGameOver();
}

function animateGameOver() {
    gameOverAnimProgress += 0.02;

    if (gameOverAnimProgress <= 1) {
        state.needsRedraw = true;
        gameOverAnimationId = requestAnimationFrame(animateGameOver);
    }
}

// ============================================================
//  RESET
// ============================================================

function resetGame() {
    state.nextId = 0;
    state.animating = false;
    state.mergeFlash = [];
    state.hoverGapIndex = -1;
    gameOverAnimProgress = 0;
    if (gameOverAnimationId) cancelAnimationFrame(gameOverAnimationId);
    initGame();
    state.needsRedraw = true;
    updateUI();
    messageBox.innerHTML = getTranslation('gameReset');
    currentActionEl.textContent = getTranslation('placeNumber');
}

// ============================================================
//  THEME SYNC (website data-theme ↔ atamas .light-mode)
// ============================================================

// Sync atamas UI to a given theme value ('light' | 'dark')
function syncAtamasTheme(theme) {
    const page = document.querySelector('.game-atamas-page');
    const btn = document.getElementById('modeToggleBtn');

    if (theme === 'light') {
        page.classList.add('light-mode');
        if (btn) btn.textContent = getTranslation('darkMode');
    } else {
        page.classList.remove('light-mode');
        if (btn) btn.textContent = getTranslation('lightMode');
    }
}

// Get current website theme
function getCurrentTheme() {
    return document.documentElement.getAttribute('data-theme') || 'light';
}

// Toggle theme — syncs with the website's global theme system
function toggleMode() {
    const currentTheme = getCurrentTheme();
    const newTheme = currentTheme === 'light' ? 'dark' : 'light';

    // Use the website's global theme switch if available
    if (window.switchTheme) {
        window.switchTheme(newTheme);
    } else {
        document.documentElement.setAttribute('data-theme', newTheme);
        localStorage.setItem('theme', newTheme);
    }

    syncAtamasTheme(newTheme);
    state.needsRedraw = true;
}

// Load theme from website state (instead of independent localStorage key)
function loadSavedMode() {
    const theme = getCurrentTheme();
    syncAtamasTheme(theme);
}

// Watch for external theme changes (e.g. navbar toggle, other tabs)
const _atamasThemeObserver = new MutationObserver((mutations) => {
    for (const mutation of mutations) {
        if (mutation.type === 'attributes' && mutation.attributeName === 'data-theme') {
            const newTheme = document.documentElement.getAttribute('data-theme');
            syncAtamasTheme(newTheme);
            state.needsRedraw = true;
        }
    }
});
_atamasThemeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });

// ============================================================
//  ANIMATION LOOP
// ============================================================

function animationLoop() {
    if (state.needsRedraw || state.pendingElement) {
        drawCanvas();
        state.needsRedraw = false;
    }
    requestAnimationFrame(animationLoop);
}

// ============================================================
//  EVENT BINDING
// ============================================================

canvas.addEventListener('click', handleCanvasClick);
canvas.addEventListener('mousemove', handleCanvasMouseMove);
canvas.addEventListener('mouseleave', handleCanvasMouseLeave);
canvas.addEventListener('touchstart', (e) => {
    e.preventDefault();
    handleCanvasClick(e);
});

document.getElementById('resetBtn').addEventListener('click', resetGame);
document.getElementById('recallBtn').addEventListener('click', recallLastMove);
document.getElementById('previewToggleBtn').addEventListener('click', () => {
    const previewBox = document.getElementById('pendingPreviewBox');
    const toggleBtn = document.getElementById('previewToggleBtn');
    previewBox.classList.toggle('hidden');
    if (previewBox.classList.contains('hidden')) {
        toggleBtn.textContent = '<';
        toggleBtn.title = getTranslation('showPreview');
    } else {
        toggleBtn.textContent = '>';
        toggleBtn.title = getTranslation('hidePreview');
    }
});

// Mode toggle
document.getElementById('modeToggleBtn').addEventListener('click', toggleMode);

// ============================================================
//  PUBLIC API
// ============================================================

window.AtamasCore = {
    state: state,
    loadSavedMode: loadSavedMode,
    initGame: initGame,
    animationLoop: animationLoop,
    getCurrentTheme: getCurrentTheme
};

})();
