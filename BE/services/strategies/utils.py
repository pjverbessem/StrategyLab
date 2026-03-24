import json


def parse_strategy_row(row: dict) -> dict:
    try:
        row["stats"] = json.loads(row["stats"])
    except Exception:
        row["stats"] = {}
    try:
        row["tags"] = json.loads(row["tags"])
    except Exception:
        row["tags"] = []
    return row
