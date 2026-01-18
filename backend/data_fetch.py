
import requests

URL = "https://data.calgary.ca/resource/cchr-krqg.json"

def fetch_buildings():
    params = {
        "$limit": 150,
        "$where": "within_box(geom,51.046,-114.071,51.049,-114.065)"
    }
    r = requests.get(URL, params=params)
    r.raise_for_status()
    return r.json()
