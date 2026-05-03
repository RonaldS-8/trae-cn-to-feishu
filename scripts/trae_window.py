import sys
import io
sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8')
sys.stderr = io.TextIOWrapper(sys.stderr.buffer, encoding='utf-8')

from pywinauto import Desktop
import time
import pyperclip
import json

def send_to_trae(message):
    desktop = Desktop(backend="uia")
    try:
        pyperclip.copy(message)
        time.sleep(0.2)

        trae_win = desktop.window(title_re=r".*Trae.*")
        trae_win.wait('visible', timeout=8)
        trae_win.set_focus()
        time.sleep(0.5)

        edits = trae_win.descendants(control_type="Edit")
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
