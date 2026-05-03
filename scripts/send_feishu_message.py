import sys
import io
sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8')
sys.stderr = io.TextIOWrapper(sys.stderr.buffer, encoding='utf-8')

import os
import json
import requests

def get_config():
    config_path = os.path.join(os.path.dirname(__file__), '..', 'config.env')
    try:
        config = {}
        with open(config_path, 'r', encoding='utf-8') as f:
            for line in f:
                line = line.strip()
                if not line or line.startswith('#'):
                    continue
                if '=' in line:
                    key, value = line.split('=', 1)
                    config[key.strip()] = value.strip().strip('"').strip("'")
        return config
    except Exception as e:
        print(json.dumps({"success": False, "error": f"Config read failed: {e}"}))
        return {}

def get_access_token(app_id, app_secret):
    url = "https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal"
    headers = {"Content-Type": "application/json"}
    data = {"app_id": app_id, "app_secret": app_secret}
    resp = requests.post(url, headers=headers, json=data, timeout=10)
    result = resp.json()
    if result.get("code") == 0:
        return result.get("tenant_access_token")
    raise Exception(f"Failed to get access_token: {result}")

def send_message(token, receive_id, content, msg_type='text'):
    url = "https://open.feishu.cn/open-apis/im/v1/messages"
    headers = {
        "Authorization": f"Bearer {token}",
        "Content-Type": "application/json"
    }
    params = {"receive_id_type": "chat_id"}
    data = {
        "receive_id": receive_id,
        "msg_type": msg_type,
        "content": json.dumps({"text": content}) if msg_type == 'text' else content
    }
    resp = requests.post(url, headers=headers, params=params, json=data, timeout=10)
    return resp.json()

def main():
    config = get_config()
    app_id = config.get('CTI_FEISHU_APP_ID')
    app_secret = config.get('CTI_FEISHU_APP_SECRET')
    chat_id = config.get('CTI_FEISHU_CHAT_ID')

    content = sys.stdin.read() if not sys.stdin.isatty() else None

    args = sys.argv[1:]
    i = 0
    while i < len(args):
        if args[i] == '-c' and i + 1 < len(args):
            content = args[i + 1]
            i += 2
        elif args[i] == '--chat-id' and i + 1 < len(args):
            chat_id = args[i + 1]
            i += 2
        else:
            if content is None:
                content = args[i]
            i += 1

    if not content:
        print(json.dumps({"success": False, "error": "No content provided"}))
        sys.exit(1)

    if not chat_id:
        print(json.dumps({"success": False, "error": "No chat_id configured"}))
        sys.exit(1)

    try:
        token = get_access_token(app_id, app_secret)
        result = send_message(token, chat_id, content)
        if result.get('code') == 0:
            print(json.dumps({"success": True}))
        else:
            print(json.dumps({"success": False, "error": result}))
    except Exception as e:
        print(json.dumps({"success": False, "error": str(e)}))

if __name__ == '__main__':
    main()
