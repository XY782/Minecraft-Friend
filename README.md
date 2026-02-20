attempt to make a minecraft bot as humanly as possible. 
will update and go onto other apps
Made out of personal interest
contribution will be appreciated ty
dont be mean if its bad. (it kinda is)
currently LSTM

How to Set Up

Bot runtime:
cd minecraft
npm install
copy .env.example → .env, set MC_HOST, MC_PORT, MC_USERNAME (and auth fields if needed)
optional: set GEMINI_API_KEY; then run npm start
Python training/inference (optional):
cd minecraft/Training/python
pip install -r requirements.txt
train with python train.py --dataset ../datasets/<file>.clean.jsonl --out-dir ../models --model-type lstm ...
serve policy with uvicorn serve_policy:app --host 127.0.0.1 --port 8765

If you want to run, use npm start after cd minecraft
p.s. you have to train it yourself for now, might add trained data later
