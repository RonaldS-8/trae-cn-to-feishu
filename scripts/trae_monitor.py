import sys
import io
sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8')
sys.stderr = io.TextIOWrapper(sys.stderr.buffer, encoding='utf-8')

from pywinauto import Application
import time
import json
import re
import os

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

def find_chat_input(win):
    edits = win.descendants(control_type="Edit")
    for e in reversed(edits):
        rect = e.rectangle()
        if rect.bottom > 700 and rect.right > 1300:
            return e
    return None

def normalize_text(text):
    return re.sub(r"\s+", " ", text).strip()

def is_noise_text(text):
    noise = {
        "TRAE",
        "\u601d\u8003\u8fc7\u7a0b",
        "\u624b\u52a8\u7ec8\u6b62\u8f93\u51fa",
        "\u5728\u7ebf\u67e5\u770b",
        "\u5728\u6c99\u7bb1\u4e2d",
        "\u4efb\u52a1\u5b8c\u6210",
        "@Builder with MCP",
        "\u60a8\u6b63\u5728\u4e0e Builder with MCP \u804a\u5929",
    }
    stripped = text.strip()
    if stripped in noise:
        return True
    if stripped in {"@", "#", "$", "\u2191"}:
        return True
    if re.match(r"^\d+/\d+\s*\u4efb\u52a1\u5b8c\u6210$", stripped):
        return True
    return False

def is_speaker_label(text):
    return text.strip() in {"Builder", "User", "\u7528\u6237"}

def is_task_complete_text(text):
    stripped = text.strip()
    return stripped == "\u4efb\u52a1\u5b8c\u6210" or bool(re.match(r"^\d+/\d+\s*\u4efb\u52a1\u5b8c\u6210$", stripped))

def has_cjk(text):
    return bool(re.search(r"[\u4e00-\u9fff]", text))

def is_generation_active(win):
    active_markers = (
        "\u624b\u52a8\u7ec8\u6b62\u8f93\u51fa",
        "\u505c\u6b62\u751f\u6210",
        "Stop generating",
    )
    for element in win.descendants():
        try:
            txt = normalize_text(element.window_text() or element.element_info.name or "")
            if is_task_complete_text(txt):
                return False
            if any(marker in txt for marker in active_markers):
                return True
        except Exception:
            pass
    return False

def has_task_completed(win):
    for element in win.descendants():
        try:
            txt = normalize_text(element.window_text() or element.element_info.name or "")
            if is_task_complete_text(txt):
                return True
        except Exception:
            pass
    return False

def get_visible_text_items(win):
    chat_input = find_chat_input(win)
    if not chat_input:
        return []

    input_rect = chat_input.rectangle()
    left_bound = max(0, input_rect.left - 80)
    right_bound = input_rect.right + 80
    top_bound = max(60, input_rect.top - 900)
    bottom_bound = input_rect.top - 15

    items = []
    allowed_types = {"Text", "Edit", "Document", "Hyperlink", "ListItem"}
    for element in win.descendants():
        try:
            ctype = element.element_info.control_type
            if ctype not in allowed_types:
                continue

            rect = element.rectangle()
            if rect.bottom < top_bound or rect.top > bottom_bound:
                continue
            if rect.right < left_bound or rect.left > right_bound:
                continue

            txt = normalize_text(element.window_text() or element.element_info.name or "")
            if not txt:
                continue
            if is_noise_text(txt) and not is_task_complete_text(txt):
                continue

            items.append({
                "seq": len(items),
                "top": rect.top,
                "bottom": rect.bottom,
                "left": rect.left,
                "right": rect.right,
                "type": ctype,
                "text": txt,
            })
        except Exception:
            pass
    return items

def items_to_reading_lines(items):
    lines = []
    buffer = ""
    prev_item = None

    def flush():
        nonlocal buffer
        if buffer:
            lines.append(normalize_text(buffer))
            buffer = ""

    for item in items:
        text = item["text"].strip()
        if not text:
            continue
        if is_speaker_label(text) or is_task_complete_text(text) or item["type"] == "ListItem":
            flush()
            lines.append(text)
            prev_item = item
            continue
        if text in {"\u601d\u8003\u8fc7\u7a0b"}:
            continue

        if prev_item and buffer and item["top"] - prev_item["bottom"] > 22:
            flush()

        if not buffer:
            buffer = text
        elif re.match(r"^[，。！？；：,.!?;:）)\]}]", text):
            buffer += text
        elif re.match(r"^[A-Za-z0-9_./\\-]+$", text) or re.match(r"^[\u4e00-\u9fff]+$", text):
            buffer += " " + text
        else:
            buffer += " " + text
        prev_item = item

    flush()
    return lines

def get_visible_text_lines(win):
    return items_to_reading_lines(get_visible_text_items(win))

def get_latest_builder_reply(lines):
    if not lines:
        return []

    end = -1
    for i, line in enumerate(lines):
        if is_task_complete_text(line):
            end = i

    search_end = end if end >= 0 else len(lines)
    start = -1
    for i in range(search_end - 1, -1, -1):
        if is_speaker_label(lines[i]):
            start = i
            break

    if start < 0:
        return []

    reply = []
    for line in lines[start + 1:search_end]:
        if is_task_complete_text(line):
            break
        if is_noise_text(line) or is_speaker_label(line):
            continue
        reply.append(line)

    return reply

def get_latest_builder_items(items):
    if not items:
        return []

    end_idx = -1
    for i, item in enumerate(items):
        if is_task_complete_text(item["text"]):
            end_idx = i

    search_end = end_idx if end_idx >= 0 else len(items)
    start_idx = -1
    for i in range(search_end - 1, -1, -1):
        if is_speaker_label(items[i]["text"]):
            start_idx = i
            break

    if start_idx < 0:
        return []

    block = []
    for item in items[start_idx + 1:search_end]:
        text = item["text"]
        if is_noise_text(text) or is_speaker_label(text):
            continue
        block.append(item)
    return block

def build_raw_response(items, lines, candidate):
    raw = {
        "mode": "raw_uia_block",
        "items": items,
        "lines": lines,
        "candidate": candidate,
    }
    return "```json\n" + json.dumps(raw, ensure_ascii=False, indent=2) + "\n```"

def diff_after_common_prefix(before, after):
    idx = 0
    while idx < len(before) and idx < len(after) and before[idx] == after[idx]:
        idx += 1
    return after[idx:]

def trim_before_prompt(lines, prompt):
    if not prompt:
        return lines

    prompt_norm = normalize_text(prompt)
    if not prompt_norm:
        return lines

    for i in range(len(lines) - 1, -1, -1):
        line = normalize_text(lines[i])
        if line and (line in prompt_norm or prompt_norm in line):
            return lines[i + 1:]

    return lines

def monitor_trae_response(timeout=60, prompt=""):
    try:
        app = find_trae_app()
        trae_win = app.top_window()

        start_time = time.time()
        last_candidate = []
        stable_since = None

        while time.time() - start_time < timeout:
            time.sleep(1)

            current = get_visible_text_lines(trae_win)
            raw_items = get_visible_text_items(trae_win)
            active = is_generation_active(trae_win)
            completed = has_task_completed(trae_win)
            candidate = get_latest_builder_reply(current)
            if not candidate:
                candidate = current
            candidate = trim_before_prompt(candidate, prompt)
            candidate = [line for line in candidate if not is_noise_text(line)]

            if candidate:
                if candidate == last_candidate:
                    if stable_since is None:
                        stable_since = time.time()
                    stable_for = time.time() - stable_since
                    if completed and stable_for >= 1.5:
                        result = {"success": True, "response": "\n".join(candidate)}
                        if os.environ.get("CTI_MONITOR_DEBUG") == "true":
                            result["debug"] = {
                                "items": get_latest_builder_items(raw_items),
                                "lines": current,
                                "candidate": candidate,
                            }
                            result["response"] = build_raw_response(result["debug"]["items"], current, candidate)
                        print(json.dumps(result, ensure_ascii=False))
                        return
                    elif not active and stable_for >= 10:
                        result = {"success": True, "response": "\n".join(candidate)}
                        if os.environ.get("CTI_MONITOR_DEBUG") == "true":
                            result["debug"] = {
                                "items": get_latest_builder_items(raw_items),
                                "lines": current,
                                "candidate": candidate,
                            }
                            result["response"] = build_raw_response(result["debug"]["items"], current, candidate)
                        print(json.dumps(result, ensure_ascii=False))
                        return
                else:
                    last_candidate = candidate
                    stable_since = time.time()

        if last_candidate:
            print(json.dumps({"success": True, "response": "\n".join(last_candidate), "timeout": True}, ensure_ascii=False))
            return

        print(json.dumps({"success": False, "error": "No response detected within timeout"}))
    except Exception as e:
        print(json.dumps({"success": False, "error": str(e)}))
        sys.exit(1)

if __name__ == "__main__":
    timeout = int(sys.argv[1]) if len(sys.argv) > 1 else 60
    prompt = sys.argv[2] if len(sys.argv) > 2 else ""
    monitor_trae_response(timeout, prompt)
