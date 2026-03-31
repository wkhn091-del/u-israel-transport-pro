from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from routers import trains, buses, flights, routing

app = FastAPI(title="Israel Transport Pro API", version="1.0.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:3000"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(trains.router, prefix="/api/trains", tags=["trains"])
app.include_router(buses.router, prefix="/api/buses", tags=["buses"])
app.include_router(flights.router, prefix="/api/flights", tags=["flights"])
app.include_router(routing.router, prefix="/api/routing", tags=["routing"])

@app.get("/")
async def root():
    return {"message": "Israel Transport Pro API", "status": "online"}
