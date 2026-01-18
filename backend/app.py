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
        return jsonify(fetch_buildings())
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

