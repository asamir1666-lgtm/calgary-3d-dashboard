import json
from flask import Flask, jsonify, request
from flask_cors import CORS
from data_fetch import fetch_buildings
from llm import parse_query
from models import db, User, Project

app = Flask(__name__)
app.config["SQLALCHEMY_DATABASE_URI"] = "sqlite:///calgary.db"
app.config["SQLALCHEMY_TRACK_MODIFICATIONS"] = False

CORS(app)
db.init_app(app)

# Create tables on startup (works on Render + locally)
with app.app_context():
    db.create_all()


@app.route("/")
def health():
    return {"status": "ok", "service": "calgary-3d-backend"}


@app.route("/api/buildings")
def buildings():
    try:
        # Returns {bbox, projection, count, buildings:[...]}
        return jsonify(fetch_buildings())
    except Exception as e:
        return jsonify({"error": str(e)}), 500


def _apply_single_filter(b: dict, f: dict) -> bool:
    attr = f.get("attribute")
    op = f.get("operator")
    val = f.get("value")

    # Prefer normalized top-level fields, fallback to raw properties
    if attr in b:
        bv = b.get(attr)
    else:
        bv = (b.get("properties") or {}).get(attr)

    if bv is None:
        return False

    try:
        if op in (">", "<"):
            return (float(bv) > float(val)) if op == ">" else (float(bv) < float(val))
        if op == "contains":
            return str(val).lower() in str(bv).lower()
        # ==
        return str(bv).lower() == str(val).lower()
    except Exception:
        return False


@app.route("/api/apply_filters", methods=["POST"])
def apply_filters():
    """Backend-side filtering: returns matching building ids.

    Body:
      {"filters": [{attribute,operator,value}, ...]}
    Response:
      {"matched_ids": [..], "count": N}
    """
    try:
        body = request.get_json(force=True)
        filters = body.get("filters") or []
        if not isinstance(filters, list):
            return jsonify({"error": "filters must be a list"}), 400

        payload = fetch_buildings()
        buildings = payload.get("buildings", [])

        matched = []
        for b in buildings:
            if all(_apply_single_filter(b, f) for f in filters):
                matched.append(b.get("id"))
        return jsonify({"matched_ids": matched, "count": len(matched)})
    except Exception as e:
        return jsonify({"error": str(e)}), 500


@app.route("/api/query", methods=["POST"])
def query():
    try:
        body = request.get_json(force=True)
        user_query = body.get("query", "").strip()
        if not user_query:
            return jsonify({"error": "Missing 'query'"}), 400

        # parse_query should return dict like:
        # {"attribute":"height","operator":">","value":100}
        filt = parse_query(user_query)
        return jsonify(filt)

    except Exception as e:
        return jsonify({"error": str(e)}), 500


@app.route("/api/save", methods=["POST"])
def save():
    try:
        data = request.get_json(force=True)
        username = data.get("username", "").strip()
        project_name = data.get("name", "").strip()
        filters = data.get("filters")

        if not username or not project_name or filters is None:
            return jsonify({"error": "Required: username, name, filters"}), 400

        user = User.query.filter_by(username=username).first()
        if not user:
            user = User(username=username)
            db.session.add(user)
            db.session.commit()

        # Upsert: overwrite if same project name exists
        project = Project.query.filter_by(user_id=user.id, name=project_name).first()
        if not project:
            project = Project(user_id=user.id, name=project_name, filters=json.dumps(filters))
            db.session.add(project)
        else:
            project.filters = json.dumps(filters)

        db.session.commit()
        return jsonify({"status": "saved", "username": username, "project": project_name})

    except Exception as e:
        return jsonify({"error": str(e)}), 500


@app.route("/api/projects/<username>")
def projects(username):
    try:
        user = User.query.filter_by(username=username).first()
        if not user:
            return jsonify([])

        results = []
        for p in Project.query.filter_by(user_id=user.id).all():
            try:
                parsed_filters = json.loads(p.filters) if p.filters else []
            except:
                parsed_filters = p.filters
            results.append({"name": p.name, "filters": parsed_filters})

        return jsonify(results)

    except Exception as e:
        return jsonify({"error": str(e)}), 500


if __name__ == "__main__":
    # Render sets PORT, local defaults to 5000
    import os
    port = int(os.environ.get("PORT", 5000))
    app.run(host="0.0.0.0", port=port, debug=True)

