/**
 * Shared admin JavaScript utilities.
 * Used by admin management pages.
 * Depends on: showToast() from base.html
 */

/**
 * Fetch wrapper for admin API calls.
 * Auto-serializes JSON body and parses JSON response.
 *
 * @param {string} url - Request URL
 * @param {string} method - HTTP method (default 'GET')
 * @param {*} body - Request body (will be JSON.stringify'd)
 * @returns {Promise<object>} Parsed JSON response
 */
async function adminRequest(url, method = 'GET', body = null) {
    const options = {
        method: method,
        headers: { 'Content-Type': 'application/json' },
    };
    if (body !== null && body !== undefined) {
        options.body = JSON.stringify(body);
    }
    const response = await fetch(url, options);
    return response.json();
}

/**
 * Creates a checkbox selection manager for batch operations.
 *
 * @param {string} checkboxSelector - CSS selector for checkboxes
 * @param {object} options
 * @param {string} [options.countElId='selected-count'] - Element ID for selection count
 * @param {string} [options.batchCountElId='batch-selected-count'] - Element ID for batch count
 * @param {string} [options.batchActionsElId='batchActions'] - Element ID for batch actions bar
 * @param {function} [options.onUpdate] - Callback(selectedIds: Set) on selection change
 * @returns {object} { update, selectAll, clearSelection, getSelectedIds }
 */
function createSelectionManager(checkboxSelector, options = {}) {
    const {
        countElId = 'selected-count',
        batchCountElId = 'batch-selected-count',
        batchActionsElId = 'batchActions',
        onUpdate = null,
    } = options;

    const selectedIds = new Set();

    function update() {
        selectedIds.clear();
        document.querySelectorAll(checkboxSelector + ':checked').forEach(cb => {
            selectedIds.add(cb.value);
        });

        const count = selectedIds.size;
        const countEl = document.getElementById(countElId);
        const batchCountEl = document.getElementById(batchCountElId);
        const batchActionsEl = document.getElementById(batchActionsElId);

        if (countEl) countEl.textContent = count;
        if (batchCountEl) batchCountEl.textContent = count;
        if (batchActionsEl) {
            batchActionsEl.classList.toggle('is-visible', count > 0);
        }

        // Highlight selected cards
        document.querySelectorAll(checkboxSelector).forEach(cb => {
            const card = cb.closest('[class*="card"]');
            if (card) {
                card.classList.toggle('is-selected', cb.checked);
            }
        });

        if (onUpdate) onUpdate(selectedIds);
    }

    function selectAll() {
        document.querySelectorAll(checkboxSelector).forEach(cb => { cb.checked = true; });
        update();
    }

    function clearSelection() {
        document.querySelectorAll(checkboxSelector).forEach(cb => { cb.checked = false; });
        update();
    }

    function getSelectedIds() {
        return Array.from(selectedIds);
    }

    // Bind change event
    document.addEventListener('change', function(e) {
        if (e.target.matches(checkboxSelector)) {
            update();
        }
    });

    return { update, selectAll, clearSelection, getSelectedIds };
}
