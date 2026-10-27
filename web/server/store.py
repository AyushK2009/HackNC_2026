"""Tiny document store: in-memory dicts (source of truth while running) with write-through to SQLite."""
from __future__ import annotations

import json
import os
import sqlite3
import threading
from pathlib import Path

# On Vercel the code directory is read-only, so the demo database lives in /tmp (reseeded on a cold start).
DB_PATH = Path("/tmp/allocate.db") if os.environ.get("VERCEL") else Path(__file__).resolve().parent / "allocate.db"
COLLECTIONS = ["reports", "opportunities", "volunteers", "projects", "activity", "adjustments", "scenarios", "orgs", "customs"]


class Store:
    def __init__(self, path: Path = DB_PATH) -> None:
        self.conn = sqlite3.connect(str(path), check_same_thread=False)
        self.conn.execute("PRAGMA journal_mode=WAL")
        self.lock = threading.RLock()
        for c in COLLECTIONS:
            self.conn.execute(f"CREATE TABLE IF NOT EXISTS {c} (id TEXT PRIMARY KEY, seq INTEGER NOT NULL, data TEXT NOT NULL)")
        self.conn.commit()
        self.mem: dict[str, dict[str, dict]] = {}
        self.seq = 0
        for c in COLLECTIONS:
            rows = self.conn.execute(f"SELECT id, seq, data FROM {c} ORDER BY seq").fetchall()
            self.mem[c] = {r[0]: json.loads(r[2]) for r in rows}
            if rows:
                self.seq = max(self.seq, rows[-1][1])

    def all(self, c: str) -> list[dict]:
        return list(self.mem[c].values())

    def get(self, c: str, id_: str) -> dict | None:
        return self.mem[c].get(id_)

    def count(self, c: str) -> int:
        return len(self.mem[c])

    def put(self, c: str, obj: dict) -> dict:
        self.put_many(c, [obj])
        return obj

    def put_many(self, c: str, objs: list[dict]) -> None:
        with self.lock:
            rows = []
            for o in objs:
                if o["id"] not in self.mem[c]:
                    self.seq += 1
                    seq = self.seq
                else:
                    seq = None
                self.mem[c][o["id"]] = o
                rows.append((o["id"], seq, json.dumps(o)))
            for id_, seq, data in rows:
                if seq is None:
                    self.conn.execute(f"UPDATE {c} SET data=? WHERE id=?", (data, id_))
                else:
                    self.conn.execute(f"INSERT OR REPLACE INTO {c} (id, seq, data) VALUES (?,?,?)", (id_, seq, data))
            self.conn.commit()

    def clear(self) -> None:
        with self.lock:
            for c in COLLECTIONS:
                self.conn.execute(f"DELETE FROM {c}")
                self.mem[c] = {}
            self.conn.commit()
            self.seq = 0
