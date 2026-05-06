import sys
import io
sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8')
sys.stderr = io.TextIOWrapper(sys.stderr.buffer, encoding='utf-8')

from pywinauto import Application

def find_trae_app():
    for pattern in (r".*Trae CN.*", r".*Trae.*"):
        try:
            return Application(backend="uia").connect(title_re=pattern)
        except Exception:
            pass
    raise Exception("No Trae window found")

if __name__ == "__main__":
    app = find_trae_app()
    win = app.top_window()
    for element in win.descendants():
        try:
            rect = element.rectangle()
            text = (element.window_text() or element.element_info.name or "").replace("\r", "\\r").replace("\n", "\\n")
            if not text.strip():
                continue
            print(f"{rect.top:04d},{rect.left:04d},{rect.bottom:04d},{rect.right:04d} {element.element_info.control_type}: {text[:160]}")
        except Exception:
            pass
