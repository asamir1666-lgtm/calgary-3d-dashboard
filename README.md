# MASIV 2025 Intern Test — Urban Design 3D City Dashboard (Calgary)

This prototype demonstrates:
- Calgary Open Data ingestion (3–4 downtown blocks)
- 3D building visualization (Three.js extrusion)
- Interactivity (click building → highlight + popup with raw attributes)
- LLM-powered natural language filtering (Hugging Face)
- Project persistence (SQLite: user + saved filter sets)

## Live demo
- Frontend: (your Netlify URL)
- Backend: (your Render URL)

## Architecture
See `uml/uml_architecture.png`.

---

## 1) Local setup

### Backend (Flask)
```bash
cd backend
python -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt

# Hugging Face key (free tier)
export HF_API_KEY=...  # from https://huggingface.co/settings/tokens

python app.py
```

Test:
```bash
curl http://localhost:5000/api/buildings
curl -X POST http://localhost:5000/api/query -H 'Content-Type: application/json' -d '{"query":"highlight buildings over 30"}'
```

### Frontend (React + Vite)
```bash
cd frontend
npm install

# Optional: point to hosted backend
export VITE_API_BASE=http://localhost:5000

npm run dev
```

Open the printed local URL.

---

## 2) Hosting (free)

### Backend on Render
1. Create a **Web Service** from this repo.
2. Build command:
   ```
   pip install -r backend/requirements.txt
   ```
3. Start command:
   ```
   python backend/app.py
   ```
4. Add env var:
   - `HF_API_KEY` = your Hugging Face token

### Frontend on Netlify
1. Import repo.
2. Base directory: `frontend`
3. Build: `npm run build`
4. Publish: `frontend/dist`
5. Add env var:
   - `VITE_API_BASE` = your Render backend URL

---

## API summary
- `GET /api/buildings` → normalized buildings + bbox
- `POST /api/query` → LLM → `{attribute, operator, value}`
- `POST /api/apply_filters` → backend filtering → `{matched_ids, count}`
- `POST /api/save` → save filters for user + project name
- `GET /api/projects/<username>` → list saved projects

---

## Notes / assumptions
- SQLite is used for lightweight persistence (user + projects).
- LLM returns one filter per query; multiple queries build a filter stack.
- If the HF key is missing or HF errors, backend falls back to regex parsing.
