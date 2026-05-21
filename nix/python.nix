# Python 3.12 with a wide stdlib-adjacent batteries set + the tooling
# every modern Python project reaches for. AI/ML stack lives here too
# so blueprint repos sharing the cache don't need to recompile numpy +
# scientific libs.
{ pkgs, lib }:

let
  python = pkgs.python312.withPackages (ps: with ps; [
    # Package management.
    pip
    setuptools
    wheel
    build
    twine
    virtualenv
    pipx

    # Core scientific.
    numpy
    scipy
    pandas
    polars
    pyarrow

    # Plotting.
    matplotlib
    seaborn
    plotly

    # Classic ML.
    scikit-learn
    scikit-image
    xgboost
    statsmodels

    # Jupyter ecosystem.
    jupyter
    jupyterlab
    ipython
    notebook
    ipykernel

    # AI / LLM clients.
    openai
    anthropic
    tiktoken
    langchain
    langchain-core
    langchain-community
    transformers
    sentencepiece

    # Vector / embeddings + retrieval.
    sentence-transformers
    faiss

    # HTTP / async.
    requests
    httpx
    aiohttp
    urllib3
    websockets
    websocket-client

    # Web frameworks.
    flask
    fastapi
    uvicorn
    gunicorn
    starlette
    quart
    sanic

    # Data validation / config.
    pydantic
    pyyaml
    toml
    tomli
    python-dotenv
    jsonschema
    marshmallow

    # CLI / TUI.
    click
    typer
    rich
    textual
    tqdm

    # Templating + parsing.
    jinja2
    beautifulsoup4
    lxml

    # DB clients.
    sqlalchemy
    alembic
    psycopg2
    redis
    pymongo
    aiosqlite

    # File formats.
    h5py
    fastparquet
    pillow

    # Crypto / signing.
    cryptography
    pyjwt
    bcrypt

    # Testing.
    pytest
    pytest-asyncio
    pytest-cov
    pytest-mock
    hypothesis
    coverage

    # Async + concurrency.
    anyio
    trio

    # Observability.
    structlog
    opentelemetry-api
    opentelemetry-sdk
    sentry-sdk

    # Web3 client surface.
    web3
    eth-account
    eth-utils

    # Misc utilities.
    boto3
  ]);
in
[
  python
  pkgs.uv
  pkgs.ruff
  pkgs.pyright
  pkgs.python312Packages.debugpy
  pkgs.python312Packages.black
  pkgs.python312Packages.mypy
  pkgs.python312Packages.isort
  pkgs.python312Packages.poetry-core
  pkgs.poetry
  pkgs.pdm
  pkgs.hatch
]
