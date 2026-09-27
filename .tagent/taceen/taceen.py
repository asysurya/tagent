#!/usr/bin/env python3
"""Taceen Tool Resolver — SKELETON (mock)."""
import json, sys

def main():
    line = sys.stdin.readline()
    try:
        req = json.loads(line)
    except json.JSONDecodeError as e:
        print(json.dumps({"status": "error", "reason": f"invalid JSON: {e}"}))
        return

    intent = req.get("intent")
    if intent == "resolve":
        out = {"available": [], "unavailable": [], "hint": f"[python-mock] resolve: {req.get('query')}"}
    elif intent == "validate":
        out = {"action": "allow"}
    else:
        out = {"status": "error", "reason": f"unknown intent: {intent}"}
    print(json.dumps(out))

if __name__ == "__main__":
    main()
