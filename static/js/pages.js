/**
 * AV-01 Navigation & Section Scroll Router
 * Smoothly scrolls .main-col to target section on navbar item click.
 */

document.addEventListener('DOMContentLoaded', () => {
    const navItems = document.querySelectorAll('.nav-item');
    const mainCol = document.querySelector('.main-col');

    function scrollToSection(targetId) {
        const section = document.getElementById(targetId);
        if (section && mainCol) {
            mainCol.scrollTo({
                top: section.offsetTop - 80,
                behavior: 'smooth'
            });

            // Update active navbar highlight
            navItems.forEach(item => {
                const href = item.getAttribute('href');
                const isMatch = href === `#${targetId}`;
                item.classList.toggle('active', isMatch);
            });
        }
    }

    // Attach click handlers to navbar links
    document.addEventListener('click', (e) => {
        const item = e.target.closest('.nav-item');
        if (item) {
            const href = item.getAttribute('href');
            if (href && href.startsWith('#')) {
                e.preventDefault();
                const targetId = href.substring(1);
                scrollToSection(targetId);
            }
        }
    });

    // Handle initial hash in URL if present
    if (window.location.hash) {
        const targetId = window.location.hash.substring(1);
        setTimeout(() => scrollToSection(targetId), 200);
    }
});


