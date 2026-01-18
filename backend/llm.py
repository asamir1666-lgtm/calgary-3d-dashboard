
import requests, os, json

API = "https://api-inference.huggingface.co/models/mistralai/Mistral-7B-Instruct-v0.2"
HEADERS = {"Authorization": f"Bearer {os.getenv('HF_API_KEY')}"}

def parse_query(text):
    prompt = f'''Extract filter as JSON.
Query: "{text}"
Return: {{ "attribute": "", "operator": "", "value": "" }}'''
    r = requests.post(API, headers=HEADERS, json={"inputs": prompt})
    return r.json()
