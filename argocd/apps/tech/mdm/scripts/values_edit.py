import re
import sys


def block_bounds(lines, start, indent):
    end = start + 1
    while end < len(lines):
        line = lines[end]
        if line.strip() and len(line) - len(line.lstrip(" ")) <= indent:
            break
        end += 1
    return end


def set_sealed(lines, secret, pairs):
    secrets = lines.index("secrets:")
    start = next(i for i in range(secrets + 1, len(lines)) if lines[i] == f"  {secret}:")
    end = block_bounds(lines, start, 2)
    enc = next(i for i in range(start + 1, end) if lines[i].startswith("    encryptedData:"))
    enc_end = block_bounds(lines, enc, 4)
    block = ["    encryptedData:"]
    for name, value in pairs:
        block.append(f'      {name}: "{value}"')
    lines[enc:enc_end] = block


def set_ca_pem(lines, pem):
    scep = lines.index("scep:")
    start = next(i for i in range(scep + 1, len(lines)) if lines[i].startswith("  caPem:"))
    end = block_bounds(lines, start, 2)
    block = ["  caPem: |"] + [f"    {row}" for row in pem.strip().splitlines()]
    lines[start:end] = block


def main():
    path, command, *args = sys.argv[1:]
    with open(path, encoding="utf-8") as fh:
        lines = fh.read().splitlines()
    if command == "sealed":
        secret, *rest = args
        set_sealed(lines, secret, [tuple(item.split("=", 1)) for item in rest])
    elif command == "capem":
        with open(args[0], encoding="utf-8") as fh:
            set_ca_pem(lines, fh.read())
    else:
        sys.exit(f"unbekanntes Kommando: {command}")
    with open(path, "w", encoding="utf-8") as fh:
        fh.write("\n".join(lines) + "\n")


if __name__ == "__main__":
    main()
