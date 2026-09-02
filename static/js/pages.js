/**
 * AV-01 Page Router & View Controller
 * Manages clean 9-screen navigation between dedicated automotive viewpanes
 * and handles WebGL canvas reparenting smoothly without breaking 3D rendering.
 */

class PageRouter {
    constructor() {
        this.activeView = 'dashboard';
        this.bindEvents();
    }

    bindEvents() {
        const attach = () => {
            document.querySelectorAll('.nav-item').forEach(btn => {
                btn.addEventListener('click', (e) => {
                    const view = btn.getAttribute('data-view');
                    if (view) {
                        e.preventDefault();
                        this.navigateTo(view);
                    }
                });
            });
        };

        if (document.readyState === 'loading') {
            document.addEventListener('DOMContentLoaded', attach);
        } else {
            attach();
        }

        // Global Event Delegation fallback for resilient navigation
        document.addEventListener('click', (e) => {
            const btn = e.target.closest('.nav-item');
            if (btn) {
                const view = btn.getAttribute('data-view');
                if (view) {
                    e.preventDefault();
                    this.navigateTo(view);
                }
            }
        });
    }

    navigateTo(view) {
        if (!view) return;
        this.activeView = view;

        // Highlight active nav item
        document.querySelectorAll('.nav-item').forEach(btn => {
            const matches = btn.getAttribute('data-view') === view;
            btn.classList.toggle('active', matches);
        });

        // Toggle view panes
        document.querySelectorAll('.view-pane').forEach(pane => {
            const matches = pane.getAttribute('data-pane') === view;
            pane.classList.toggle('active', matches);
        });

        // WebGL Canvas Reparenting (Prevents 3D view breakage across tabs)
        if (typeof renderer !== 'undefined' && renderer.domElement) {
            let targetBoxId = (view === 'livedrive') ? 'viewport-box-livedrive' : 'viewport-box-sim';
            let targetBox = document.getElementById(targetBoxId);

            if (targetBox && targetBox.clientWidth > 0 && targetBox.clientHeight > 0) {
                if (renderer.domElement.parentElement !== targetBox) {
                    targetBox.appendChild(renderer.domElement);
                }
                renderer.setSize(targetBox.clientWidth, targetBox.clientHeight);
                if (typeof camera !== 'undefined') {
                    camera.aspect = targetBox.clientWidth / targetBox.clientHeight;
                    camera.updateProjectionMatrix();
                }
            }
        }

        // Render target page-specific graphics immediately
        if (view === 'analytics') {
            if (typeof renderAnalyticsCharts === 'function') renderAnalyticsCharts();
        } else if (view === 'decisions') {
            if (typeof updateDecisionsUI === 'function') updateDecisionsUI();
        }
    }
}

window.pageRouter = new PageRouter();
window.navigateTo = (view) => window.pageRouter.navigateTo(view);

// About Modal Handlers
window.openAboutModal = function() {
    const modal = document.getElementById('aboutModal');
    if (modal) modal.classList.add('active');
};

window.closeAboutModal = function() {
    const modal = document.getElementById('aboutModal');
    if (modal) modal.classList.remove('active');
};
