import re

with open('static/index.html', 'r') as f:
    html = f.read()

# Extract CSS
css_match = re.search(r'<style>(.*?)</style>', html, flags=re.DOTALL)
if css_match:
    css_content = css_match.group(1)
    with open('static/style.css', 'w') as f:
        f.write(css_content.strip())
    html = html.replace(css_match.group(0), '<link rel="stylesheet" href="/static/style.css">')

# Extract JS
js_match = re.search(r'<script>(.*?)</script>\n</body>', html, flags=re.DOTALL)
if js_match:
    js_content = js_match.group(1)
    with open('static/app.js', 'w') as f:
        f.write(js_content.strip())
    html = html.replace(js_match.group(0), '<script src="/static/app.js"></script>\n</body>')

with open('static/index.html', 'w') as f:
    f.write(html)
