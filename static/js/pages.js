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

        // WebGL Canvas Reparenting (keeps 3D scene live across tab switches)
        if (typeof renderer !== 'undefined' && renderer.domElement) {
            const targetBox = document.getElementById('viewport-box-sim');
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

        // Page-specific callbacks
        if (view === 'analytics') {
            if (typeof renderAnalyticsCharts === 'function') renderAnalyticsCharts();
        } else if (view === 'decisions') {
            if (typeof updateDecisionsUI === 'function') updateDecisionsUI();
        } else if (view === 'map') {
            // Initialize MapLibre on first visit to map page
            if (typeof window.onMapPageActivated === 'function') window.onMapPageActivated();
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
