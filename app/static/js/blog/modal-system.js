// 模态框管理系统
class ModalSystem {
    constructor() {
        this.modals = {};
        this.init();
    }

    init() {
        // 初始化所有模态框
        this.setupAllModals();

        // 绑定全局事件
        this.bindGlobalEvents();

        // 绑定确认按钮事件
        this.bindConfirmButtons();
    }

    // 设置所有模态框
    setupAllModals() {
        const modalElements = document.querySelectorAll('.modal');

        modalElements.forEach(modal => {
            this.setupModal(modal);
        });
    }

    // 设置单个模态框
    setupModal(modalEl) {
        if (!modalEl) return;

        // 点击背景关闭
        modalEl.addEventListener('click', (e) => {
            if (e.target === modalEl) {
                this.closeModal(modalEl);
            }
        });

        // 点击关闭按钮关闭
        modalEl.querySelectorAll('[data-modal-close]').forEach((el) => {
            el.addEventListener('click', () => this.closeModal(modalEl));
        });
    }

    // 绑定全局事件
    bindGlobalEvents() {
        // ESC 键关闭模态框
        document.addEventListener('keydown', (e) => {
            if (e.key === 'Escape') {
                const openModal = document.querySelector('.modal.show');
                if (openModal) {
                    this.closeModal(openModal);
                }
            }
        });
    }

    // 绑定确认按钮事件
    bindConfirmButtons() {
        // 文章删除确认按钮
        const confirmDeleteBtn = document.getElementById('confirm-delete-btn');
        if (confirmDeleteBtn) {
            confirmDeleteBtn.addEventListener('click', () => {
                // 这里需要调用 AdminControlsManager 的删除方法
                const adminControls = window.adminControlsManager;
                if (adminControls && typeof adminControls.performDelete === 'function') {
                    adminControls.performDelete();
                } else {
                    console.error('AdminControlsManager not found or performDelete method not available');
                }
            });
        }

        // 评论删除确认按钮已经在 CommentManager 中绑定
    }

    // 打开模态框
    openModal(modalEl) {
        if (!modalEl) return;
        modalEl._prevActiveEl = document.activeElement;
        modalEl.classList.add('is-open');
        modalEl.classList.add('show');
        modalEl.setAttribute('aria-hidden', 'false');
        modalEl.setAttribute('aria-modal', 'true');
        document.body.style.overflow = 'hidden';
        this.setBackgroundInert(true, modalEl);
        const focusable = modalEl.querySelectorAll('a[href], button:not([disabled]), textarea, input, select, [tabindex]:not([tabindex="-1"])');
        if (focusable.length > 0) {
            focusable[0].focus();
        } else {
            modalEl.focus();
        }
        modalEl._onKeydown = (e) => {
            if (e.key === 'Escape') { this.closeModal(modalEl); }
            this.trapFocus(modalEl, e);
        };
        document.addEventListener('keydown', modalEl._onKeydown);
    }

    // 关闭模态框
    closeModal(modalEl) {
        if (!modalEl) return;
        modalEl.classList.remove('is-open');
        modalEl.classList.remove('show');
        modalEl.setAttribute('aria-hidden', 'true');
        modalEl.removeAttribute('aria-modal');
        document.body.style.overflow = '';
        this.setBackgroundInert(false, modalEl);
        if (modalEl._onKeydown) {
            document.removeEventListener('keydown', modalEl._onKeydown);
            modalEl._onKeydown = null;
        }
        if (modalEl._prevActiveEl && typeof modalEl._prevActiveEl.focus === 'function') {
            modalEl._prevActiveEl.focus();
        }
        modalEl._prevActiveEl = null;
    }

    // 设置背景不可交互
    setBackgroundInert(enable, excludeEl) {
        const children = Array.from(document.body.children);

        children.forEach(node => {
            if (excludeEl && (node === excludeEl || node.contains(excludeEl))) return;

            if (enable) {
                node.setAttribute('inert', '');
            } else {
                node.removeAttribute('inert');
            }
        });
    }

    // 焦点管理
    trapFocus(modalEl, event) {
        if (event && event.key !== 'Tab') return;

        const focusable = modalEl.querySelectorAll(
            'a[href], button:not([disabled]), textarea, input, select, [tabindex]:not([tabindex="-1"])'
        );

        if (focusable.length === 0) return;

        const first = focusable[0];
        const last = focusable[focusable.length - 1];

        if (event) {
            if (event.shiftKey) {
                if (document.activeElement === first) {
                    last.focus();
                    event.preventDefault();
                }
            } else {
                if (document.activeElement === last) {
                    first.focus();
                    event.preventDefault();
                }
            }
        } else {
            // 如果没有事件，设置焦点到第一个可聚焦元素
            first.focus();
        }
    }

    // 公共方法：打开指定ID的模态框
    openModalById(modalId) {
        const modal = document.getElementById(modalId);
        if (modal) {
            this.openModal(modal);
        }
    }

    // 公共方法：关闭指定ID的模态框
    closeModalById(modalId) {
        const modal = document.getElementById(modalId);
        if (modal) {
            this.closeModal(modal);
        }
    }
}

// 初始化模态框系统
document.addEventListener('DOMContentLoaded', function() {
    window.modalSystem = new ModalSystem();
});
