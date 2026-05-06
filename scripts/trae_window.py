import sys
import io
sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8')
sys.stderr = io.TextIOWrapper(sys.stderr.buffer, encoding='utf-8')

from pywinauto import Application
import time
import pyperclip
import json

def find_trae_app():
    try:
        app = Application(backend="uia").connect(title_re=r".*Trae CN.*")
        return app
    except Exception:
        pass
    try:
        app = Application(backend="uia").connect(title_re=r".*Trae.*")
        return app
    except Exception:
        raise Exception("No Trae window found. Is Trae CN running?")

def send_to_trae(message):
    try:
        app = find_trae_app()
        trae_win = app.top_window()
        trae_win.set_focus()
        time.sleep(0.5)

        pyperclip.copy(message)
        time.sleep(0.2)

        edits = trae_win.descendants(control_type="Edit")
        if not edits:
            raise Exception("No input box found in Trae window")
        chat_box = edits[-1]

        chat_box.click_input()
        time.sleep(0.3)

        chat_box.type_keys("^a")
        time.sleep(0.15)
        chat_box.type_keys("{BACKSPACE}")
        time.sleep(0.15)

        chat_box.type_keys("^v")
        time.sleep(0.3)

        chat_box.type_keys("{ENTER}")
        print(json.dumps({"success": True, "message": "Message sent to Trae"}))
    except Exception as e:
        print(json.dumps({"success": False, "error": str(e)}))
        sys.exit(1)

if __name__ == "__main__":
    if len(sys.argv) < 2:
        print(json.dumps({"success": False, "error": "Usage: python trae_window.py <message>"}))
        sys.exit(1)

    message = sys.argv[1]
    send_to_trae(message)
