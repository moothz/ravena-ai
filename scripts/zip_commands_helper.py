#!/usr/bin/env python3
import sys
import os
import json
import re
import zipfile
import shutil

def sanitize_filename(filename):
    return os.path.basename(filename)

def export_zip(commands_json_path, media_dir, output_zip_path):
    with open(commands_json_path, 'r', encoding='utf-8') as f:
        commands = json.load(f)

    media_files = set()
    media_pattern = re.compile(r'\{([a-zA-Z0-9_]+)-([^}]+)\}')

    for cmd in commands:
        if cmd.get('deleted'):
            continue
        responses = cmd.get('responses', [])
        for resp in responses:
            if isinstance(resp, str):
                match = media_pattern.search(resp)
                if match:
                    filename = match.group(2)
                    media_files.add(sanitize_filename(filename))

    with zipfile.ZipFile(output_zip_path, 'w', zipfile.ZIP_DEFLATED) as zf:
        zf.writestr('commands.json', json.dumps(commands, ensure_ascii=False, indent=2))

        for filename in media_files:
            file_path = os.path.join(media_dir, filename)
            if os.path.isfile(file_path):
                zf.write(file_path, arcname=f"media/{filename}")

    print(json.dumps({
        "success": True,
        "media_count": len(media_files),
        "commands_count": len(commands)
    }))

def import_zip(input_zip_path, target_media_dir, output_commands_json_path):
    os.makedirs(target_media_dir, exist_ok=True)
    temp_dir = input_zip_path + "_extracted"
    os.makedirs(temp_dir, exist_ok=True)

    try:
        with zipfile.ZipFile(input_zip_path, 'r') as zf:
            for member in zf.namelist():
                norm = os.path.normpath(member)
                if norm.startswith("..") or os.path.isabs(norm):
                    raise ValueError(f"Caminho inseguro detectado no arquivo zip: {member}")
                zf.extract(member, temp_dir)

        extracted_commands_path = os.path.join(temp_dir, 'commands.json')
        if not os.path.isfile(extracted_commands_path):
            raise ValueError("O arquivo zip não contém o arquivo 'commands.json'")

        with open(extracted_commands_path, 'r', encoding='utf-8') as f:
            commands = json.load(f)

        extracted_media_dir = os.path.join(temp_dir, 'media')
        restored_media_count = 0
        if os.path.isdir(extracted_media_dir):
            for file_name in os.listdir(extracted_media_dir):
                src_file = os.path.join(extracted_media_dir, file_name)
                if os.path.isfile(src_file):
                    dst_file = os.path.join(target_media_dir, sanitize_filename(file_name))
                    if not os.path.exists(dst_file):
                        shutil.copy2(src_file, dst_file)
                    restored_media_count += 1

        with open(output_commands_json_path, 'w', encoding='utf-8') as f:
            json.dump(commands, f, ensure_ascii=False, indent=2)

        print(json.dumps({
            "success": True,
            "commands_count": len(commands),
            "media_count": restored_media_count
        }))

    finally:
        if os.path.exists(temp_dir):
            shutil.rmtree(temp_dir, ignore_errors=True)

if __name__ == '__main__':
    if len(sys.argv) < 2:
        print(json.dumps({"success": False, "error": "Argumentos insuficientes"}))
        sys.exit(1)

    mode = sys.argv[1]
    try:
        if mode == 'export':
            export_zip(sys.argv[2], sys.argv[3], sys.argv[4])
        elif mode == 'import':
            import_zip(sys.argv[2], sys.argv[3], sys.argv[4])
        else:
            print(json.dumps({"success": False, "error": f"Modo desconhecido: {mode}"}))
            sys.exit(1)
    except Exception as e:
        print(json.dumps({"success": False, "error": str(e)}))
        sys.exit(1)
