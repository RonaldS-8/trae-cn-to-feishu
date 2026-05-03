import sys
import io
sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8')
sys.stderr = io.TextIOWrapper(sys.stderr.buffer, encoding='utf-8')

from pywinauto import Desktop
import time
import json

def monitor_trae_response(timeout=30):
    desktop = Desktop(backend="uia")
    try:
        trae_win = desktop.window(title_re=r".*Trae.*")
        trae_win.wait('visible', timeout=8)
        trae_win.set_focus()
        time.sleep(0.5)

        # Find the chat response area (usually a List or Text element)
        # Wait for response to appear
        start_time = time.time()
        last_text = ""

        while time.time() - start_time < timeout:
            try:
                texts = trae_win.descendants(control_type="Text")
                if texts:
                    # Get the last few text elements which likely contain the response
                    response_texts = []
                    for t in texts[-5:]:
                        try:
                            txt = t.window_text()
                            if txt and txt.strip():
                                response_texts.append(txt.strip())
                        except:
                            pass

                    current_text = "\n".join(response_texts)
                    if current_text and current_text != last_text:
                        last_text = current_text
                        # Check if response seems complete (no typing indicator)
                        time.sleep(2)
                        texts2 = trae_win.descendants(control_type="Text")
                        response_texts2 = []
                        for t in texts2[-5:]:
                            try:
                                txt = t.window_text()
                                if txt and txt.strip():
                                    response_texts2.append(txt.strip())
                            except:
                                pass
                        current_text2 = "\n".join(response_texts2)
                        if current_text2 == current_text:
                            # Response stabilized
                            print(json.dumps({"success": True, "response": current_text}))
                            return
                        last_text = current_text2
            except Exception:
                pass
            time.sleep(1)

        # Timeout - return whatever we have
        if last_text:
            print(json.dumps({"success": True, "response": last_text, "timeout": True}))
        else:
            print(json.dumps({"success": False, "error": "No response detected within timeout"}))
    except Exception as e:
        print(json.dumps({"success": False, "error": str(e)}))
        sys.exit(1)

if __name__ == "__main__":
    timeout = int(sys.argv[1]) if len(sys.argv) > 1 else 30
    monitor_trae_response(timeout)
