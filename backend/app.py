
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

@app.before_first_request
def create_tables():
    db.create_all()

@app.route("/api/buildings")
def buildings():
    return jsonify(fetch_buildings())

@app.route("/api/query", methods=["POST"])
def query():
    return jsonify(parse_query(request.json["query"]))

@app.route("/api/save", methods=["POST"])
def save():
    data = request.json
    user = User.query.filter_by(username=data["username"]).first()
    if not user:
        user = User(username=data["username"])
        db.session.add(user)
        db.session.commit()
    project = Project(user_id=user.id, name=data["name"], filters=json.dumps(data["filters"]))
    db.session.add(project)
    db.session.commit()
    return {"status": "saved"}

@app.route("/api/projects/<username>")
def projects(username):
    user = User.query.filter_by(username=username).first()
    if not user:
        return jsonify([])
    return jsonify([{"name": p.name, "filters": p.filters} for p in Project.query.filter_by(user_id=user.id)])
