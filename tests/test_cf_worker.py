import pytest
import os
from dotenv import load_dotenv
from openai import AsyncOpenAI
load_dotenv()


def api_endpoint():
    env = os.environ.get('ENV', 'development')
    if env == 'production':
        return "https://llmapi.ultrasev.com"
    elif env == 'development':
        return "http://192.168.31.46:3000"
    else:
        raise ValueError(f"Invalid environment: {env}")


API_ENDPOINT = api_endpoint()


async def make_request(api_key: str,
                       model: str,
                       supplier: str):
    BASE_URL = API_ENDPOINT
    client = AsyncOpenAI(base_url=BASE_URL, api_key=api_key)
    response = await client.chat.completions.create(
        model=model,
        messages=[
            {"role": "system", "content": "You are a helpful assistant。"},
            {"role": "user", "content": "what is the result of 2 * 21?"}
        ],
        extra_headers={"supplier": supplier},
    )
    return response.choices[0].message.content


@pytest.mark.asyncio
async def test_groq():
    response = await make_request(
        api_key=os.environ["GROQ_API_KEY"],
        model="llama3-70b-8192",
        supplier="groq"
    )
    assert '42' in response


@pytest.mark.asyncio
async def test_gemini():
    response = await make_request(
        api_key=os.environ["GEMINI_API_KEY"],
        model="gemini-1.5-pro-latest",
        supplier="gemini"
    )
    assert '42' in response


@pytest.mark.asyncio
async def test_openai():
    response = await make_request(
        api_key=os.environ["OPENAI_API_KEY"],
        model="gpt-3.5-turbo-1106",
        supplier="openai"
    )
    assert '42' in response
