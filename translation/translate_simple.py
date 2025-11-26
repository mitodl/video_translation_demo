#!/usr/bin/env python3
"""
Simple SRT translation script with automatic chunking on token limit errors.

Supports multiple LLM providers: gemini, openai, deepl
Automatically retries with smaller chunks when token limits are exceeded.
"""

import argparse
import os
import re
import sys
from pathlib import Path
from typing import List, Optional

import deepl
from dotenv import load_dotenv
from google import genai
from google.genai import types
from openai import OpenAI

# Add srt_translation submodule to path
project_root = Path(__file__).parent.parent
sys.path.insert(0, str(project_root / "external" / "srt_translation"))

import translate_srt

# Load environment variables
load_dotenv()

# DeepL language code mapping
DEEPL_LANG_CODES = {
    "fr": "FR",
    "de": "DE",
    "es": "ES",
    "pt": "PT-PT",
    "pt-br": "PT-BR",
    "hi": "HI",
    "ar": "AR",
    "zh": "ZH",
    "kr": "KO",
    "ja": "JA",
    "id": "ID",
    "ru": "RU",
    "el": "EL",
    "tr": "TR",
    "sq": "SQ",
}


def split_srt_into_chunks(srt_text: str, num_chunks: int) -> List[str]:
    """
    Split SRT text into chunks by subtitle blocks, preserving original format.

    This splits the original SRT text at block boundaries without parsing/rebuilding,
    so the exact original format (spacing, multi-line subtitles, etc.) is preserved.
    """
    if num_chunks <= 1:
        return [srt_text]

    # Parse to find block boundaries, but keep original text
    blocks = translate_srt.parse_srt(srt_text)
    if not blocks:
        return [srt_text]

    # Normalize line endings for consistent splitting
    normalized_text = srt_text.replace("\r\n", "\n").replace("\r", "\n")

    # Split on double newlines (SRT block separator)
    # This regex splits on one or more blank lines
    raw_blocks = [b.strip() for b in normalized_text.split("\n\n") if b.strip()]

    if len(raw_blocks) != len(blocks):
        # Fallback: if splitting doesn't match parsing, return original
        return [srt_text]

    # Split raw blocks into chunks
    chunk_size = max(1, len(raw_blocks) // num_chunks)
    chunks = []

    for i in range(0, len(raw_blocks), chunk_size):
        chunk_blocks = raw_blocks[i:i + chunk_size]
        # Join blocks with double newline (standard SRT format)
        chunks.append("\n\n".join(chunk_blocks) + "\n\n")

    return chunks


def validate_timestamps(original_srt: str, translated_srt: str) -> bool:
    """
    Validate that timestamps and cue numbers are preserved in translation.
    Returns True if valid, prints warnings and returns False if issues found.
    """
    original_blocks = translate_srt.parse_srt(original_srt)
    translated_blocks = translate_srt.parse_srt(translated_srt)

    issues = []

    if len(original_blocks) != len(translated_blocks):
        issues.append(f"Cue count mismatch: original has {len(original_blocks)}, translated has {len(translated_blocks)}")

    for i, (orig, trans) in enumerate(zip(original_blocks, translated_blocks)):
        if orig["number"] != trans["number"]:
            issues.append(f"Cue {i+1}: number mismatch (original: {orig['number']}, translated: {trans['number']})")

        if orig["timestamp"] != trans["timestamp"]:
            issues.append(f"Cue {i+1}: timestamp mismatch\n  Original:   {orig['timestamp']}\n  Translated: {trans['timestamp']}")

    if issues:
        print("\n⚠️  WARNING: Translation validation found issues:")
        for issue in issues[:10]:  # Show first 10 issues
            print(f"  - {issue}")
        if len(issues) > 10:
            print(f"  ... and {len(issues) - 10} more issues")
        return False

    return True


_BLOCK_SPLIT_RE = re.compile(r"\n\s*\n+")
_CUE_NUMBER_RE = re.compile(r"^(?:###\s*)?\d+\s*$")


def _extract_translated_texts(translated_srt: str, expected_blocks: int) -> Optional[List[str]]:
    """Return subtitle texts (sans numbers/timestamps) if we can match expected block count."""
    if expected_blocks <= 0:
        return None

    parsed_blocks = translate_srt.parse_srt(translated_srt)
    if len(parsed_blocks) == expected_blocks:
        return [block.get("text", "").strip() for block in parsed_blocks]

    normalized = translated_srt.replace("\r\n", "\n").replace("\r", "\n").strip()
    if not normalized:
        return None

    raw_blocks = [blk.strip() for blk in _BLOCK_SPLIT_RE.split(normalized) if blk.strip()]
    if len(raw_blocks) < expected_blocks:
        return None

    texts: List[str] = []
    for raw in raw_blocks:
        lines = [ln.rstrip() for ln in raw.splitlines()]
        while lines:
            stripped = lines[0].strip()
            if _CUE_NUMBER_RE.match(stripped) or translate_srt._TS_RE.match(stripped):
                lines.pop(0)
                continue
            break
        cleaned = "\n".join(line.rstrip() for line in lines).strip()
        texts.append(cleaned)

    if len(texts) >= expected_blocks:
        return texts[:expected_blocks]

    return None


def _rebuild_chunk_with_original_metadata(original_chunk: str, translated_chunk: str) -> str:
    """Use original cue numbers/timestamps while keeping translated text for a chunk."""
    original_blocks = translate_srt.parse_srt(original_chunk)
    expected_blocks = len(original_blocks)
    if expected_blocks == 0:
        return translated_chunk

    translated_texts = _extract_translated_texts(translated_chunk, expected_blocks)
    if not translated_texts or len(translated_texts) != expected_blocks:
        return translated_chunk

    rebuilt_lines: List[str] = []
    for block, text in zip(original_blocks, translated_texts):
        block_lines = [block["number"]]
        timestamp = block.get("timestamp", "")
        if timestamp:
            block_lines.append(timestamp)
        cleaned_text = text.strip()
        if cleaned_text:
            block_lines.append(cleaned_text)
        rebuilt_lines.extend(block_lines)
        rebuilt_lines.append("")

    rebuilt = "\n".join(rebuilt_lines).rstrip()
    return rebuilt + "\n\n"


def repair_timestamps_with_llm(original_srt: str, misaligned_srt: str, api_key: str) -> str:
    """
    Use an LLM to fix misaligned timestamps by copying them from the original SRT.
    Uses OpenAI for reliability.
    """
    client = OpenAI(api_key=api_key)

    system_prompt = (
        "You are fixing timestamp alignment issues in a translated SRT file.\n\n"
        "You will receive:\n"
        "1. ORIGINAL English SRT with correct timestamps\n"
        "2. TRANSLATED SRT with potentially incorrect timestamps\n\n"
        "Your task:\n"
        "- Copy EVERY timestamp and cue number EXACTLY from the ORIGINAL SRT\n"
        "- Keep, split, or modify the translated text from the TRANSLATED SRT as necessary to align timestamps\n"
        "- Return a corrected SRT with original timestamps and translated text\n\n"
    )

    user_prompt = (
        "ORIGINAL ENGLISH SRT (with correct timestamps):\n"
        "```\n"
        f"{original_srt}\n"
        "```\n\n"
        "TRANSLATED SRT (with incorrect timestamps that need fixing):\n"
        "```\n"
        f"{misaligned_srt}\n"
        "```\n\n"
        "Please return the corrected SRT with timestamps from the ORIGINAL and text from the TRANSLATED."
    )
    
    config = types.GenerateContentConfig(
        system_instruction=system_prompt,
        temperature=0.0,
    )

    response = client.models.generate_content(
        model="gemini-3-pro-preview",
        contents=[user_prompt],
        config=config,
    )
    return response.text.strip()



def translate_with_chunking(
    srt_text: str,
    provider_name: str,
    translate_chunk_fn,
    repair_api_key: Optional[str] = None,
    max_chunks: int = 16,
) -> str:
    """
    Generic translation wrapper with automatic chunking on token errors.

    Args:
        srt_text: The SRT content to translate
        provider_name: Name of the provider (for logging)
        translate_chunk_fn: Function that takes a single chunk and returns translated text
        repair_api_key: OpenAI API key for timestamp repair (optional)
        max_chunks: Maximum number of chunks to try (default: 16)

    Returns:
        Translated SRT text
    """
    num_chunks = 1
    last_error = None

    while num_chunks <= max_chunks:
        try:
            chunks = split_srt_into_chunks(srt_text, num_chunks)
            print(f"[{provider_name}] Attempting translation with {num_chunks} chunk(s)...")

            translated_chunks = []
            for idx, chunk in enumerate(chunks):
                print(f"  Translating chunk {idx + 1}/{len(chunks)} ({len(chunk)} chars)...")
                translated_chunk = translate_chunk_fn(chunk)
                enforced_chunk = _rebuild_chunk_with_original_metadata(chunk, translated_chunk)
                if enforced_chunk != translated_chunk:
                    print("    ↳ Reapplied original cue numbers/timestamps for chunk")
                translated_chunks.append(enforced_chunk)

            result = "\n\n".join(translated_chunks)

            # Validate timestamps are preserved
            print(f"  Validating timestamps...")
            if validate_timestamps(srt_text, result):
                print(f"  ✓ Timestamps validated successfully")
                return result
            else:
                print(f"  ⚠️  Timestamp validation failed - attempting automatic repair...")

                # Try to repair timestamps if we have an API key
                if repair_api_key:
                    try:
                        print(f"  🔧 Repairing timestamps using LLM...")
                        repaired = repair_timestamps_with_llm(srt_text, result, repair_api_key)

                        # Validate the repair
                        print(f"  Validating repaired timestamps...")
                        if validate_timestamps(srt_text, repaired):
                            print(f"  ✅ Timestamps successfully repaired!")
                            return repaired
                        else:
                            print(f"  ⚠️  Repair attempt did not fully fix timestamps, using repaired version anyway")
                            return repaired
                    except Exception as repair_error:
                        print(f"  ❌ Timestamp repair failed: {repair_error}")
                        print(f"  Returning original translation with misaligned timestamps")
                        return result
                else:
                    print(f"  ⚠️  No repair API key available, returning translation with misaligned timestamps")
                    return result

        except Exception as e:
            last_error = e
            error_str = str(e).lower()
            # Check for token/quota/size limit errors
            if any(term in error_str for term in ["token", "quota", "limit", "too large", "413", "context_length_exceeded"]):
                if num_chunks >= max_chunks:
                    raise RuntimeError(f"Failed even after chunking into {max_chunks} pieces: {e}")
                num_chunks *= 2
                print(f"  Token limit hit. Retrying with {num_chunks} chunks...")
            else:
                raise

    raise RuntimeError(f"Translation failed: {last_error}")


def translate_with_deepl(srt_text: str, target_lang: str, api_key: str, repair_api_key: Optional[str] = None, enable_experimental: bool = True) -> str:
    """Translate SRT using DeepL with experimental languages enabled."""
    target_code = DEEPL_LANG_CODES.get(target_lang.lower())
    if not target_code:
        raise ValueError(f"DeepL does not support language '{target_lang}'. Supported: {list(DEEPL_LANG_CODES.keys())}")

    translator = deepl.Translator(auth_key=api_key)
    extra_params = {}
    if enable_experimental:
        extra_params["enable_beta_languages"] = True

    def translate_chunk(chunk: str) -> str:
        response = translator.translate_text(
            chunk,
            source_lang="EN",
            target_lang=target_code,
            preserve_formatting=True,
            split_sentences="nonewlines",
            extra_body_parameters=extra_params,
        )
        if isinstance(response, list):
            return "\n".join(r.text for r in response)
        return response.text

    return translate_with_chunking(srt_text, "DeepL", translate_chunk, repair_api_key)


def get_translation_system_prompt(target_lang: str) -> str:
    """Generate the standard system prompt for SRT translation."""
    lang_name = translate_srt.LANG_NAMES.get(target_lang, target_lang)
    return (
        f"You are a professional translator. Translate the subtitle text provided below from English to {lang_name}.\n"
        "The input format is:\n"
        ":::ID:::\n"
        "Original Text\n\n"
        "You must output the translation in the EXACT same format:\n"
        ":::ID:::\n"
        "Translated Text\n\n"
        "CRITICAL INSTRUCTIONS:\n"
        "1. Do not translate the IDs. Do not change the IDs.\n"
        "2. Ensure EVERY ID from the input is present in the output.\n"
        "3. If a translation combines two input blocks, separate the translated text into separate blocks again in order to match the original input blocks.\n"
        "4. Maintain the 1:1 mapping between Input ID and Output ID.\n"
        "5. Maintain the context of the whole transcript."
    )


def translate_with_openai(srt_text: str, target_lang: str, api_key: str, repair_api_key: Optional[str] = None, system_prompt: Optional[str] = None) -> str:
    """Translate SRT using OpenAI with structured prompt to preserve timestamps."""
    client = OpenAI(api_key=api_key)
    
    if system_prompt is None:
        system_prompt = get_translation_system_prompt(target_lang)

    def call_llm(srt_text: str) -> str:
        response = client.chat.completions.create(
            model="gpt-5",
            messages=[
                {"role": "system", "content": system_prompt},
                {"role": "user", "content": srt_text},
            ],
            reasoning_effort="low",
        )
        return response.choices[0].message.content.strip()

    return translate_content_preserving_timestamps(srt_text, call_llm)


def translate_with_gemini(srt_text: str, target_lang: str, api_key: str, repair_api_key: Optional[str] = None, system_prompt: Optional[str] = None) -> str:
    """Translate SRT using Gemini with structured prompt to preserve timestamps."""
    client = genai.Client(api_key=api_key)
    
    if system_prompt is None:
        system_prompt = get_translation_system_prompt(target_lang)

    config = types.GenerateContentConfig(
        system_instruction=system_prompt,
        temperature=0.0,
    )

    def call_llm(srt_text: str) -> str:
        response = client.models.generate_content(
            model="gemini-3-pro-preview",
            contents=[srt_text],
            config=config,
        )
        return response.text.strip()

    return translate_content_preserving_timestamps(srt_text, call_llm)


def parse_structured_response(response_text: str, original_blocks: List[dict]) -> List[dict]:
    """
    Parse the structured response (:::ID:::\nText) and map back to original blocks.
    Returns a list of blocks with translated text and original timestamps.
    """
    # Create a map of ID -> Original Block
    block_map = {str(b["number"]): b for b in original_blocks}
    translated_blocks = []
    
    # Regex to find :::ID::: markers
    # We look for :::(\d+)::: followed by content until the next marker or end of string
    pattern = re.compile(r":::(\d+):::\s*(.*?)(?=(?::::\d+:::|$))", re.DOTALL)
    
    matches = pattern.findall(response_text)
    
    found_ids = set()
    
    for cue_num, text in matches:
        cue_num = cue_num.strip()
        text = text.strip()
        
        if cue_num in block_map:
            original = block_map[cue_num]
            translated_blocks.append({
                "number": original["number"],
                "timestamp": original["timestamp"],
                "text": text
            })
            found_ids.add(cue_num)
    
    # Handle missing blocks (fallback to original text or empty)
    # We want to preserve the order of original blocks
    final_blocks = []
    for block in original_blocks:
        cue_num = str(block["number"])
        if cue_num in found_ids:
            # Find the translated version
            # (This is inefficient for large lists, but SRTs are usually small enough)
            trans = next(b for b in translated_blocks if str(b["number"]) == cue_num)
            final_blocks.append(trans)
        else:
            print(f"  ⚠️  Warning: Block {cue_num} missing in translation response. Leaving empty.")
            final_blocks.append({
                "number": block["number"],
                "timestamp": block["timestamp"],
                "text": ""
            })
            
    return final_blocks


def translate_content_preserving_timestamps(
    srt_text: str,
    llm_call_fn,
    batch_size: int = 2000
) -> str:
    """
    Translates SRT content by extracting text, sending to LLM in a structured format,
    and re-assembling. This guarantees timestamps are preserved exactly.
    
    Args:
        srt_text: Original SRT content
        target_lang: Target language code
        llm_call_fn: Function(prompt) -> response_text
        batch_size: Number of blocks to send in one context (default 2000, effectively full file)
    """
    blocks = translate_srt.parse_srt(srt_text)
    if not blocks:
        return srt_text

    # Split blocks into batches if necessary (though we prefer full context)
    # For most SRTs, one batch is enough.
    
    translated_blocks_all = []
    
    for i in range(0, len(blocks), batch_size):
        batch_blocks = blocks[i:i + batch_size]
        
        # Construct prompt content
        prompt_parts = []
        for block in batch_blocks:
            prompt_parts.append(f":::{block['number']}:::")
            prompt_parts.append(block['text'])
            prompt_parts.append("")
            
        input_text = "\n".join(prompt_parts)
        
        print(f"  Translating batch {i//batch_size + 1} ({len(batch_blocks)} blocks)...")
        response_text = llm_call_fn(input_text)
        
        batch_translated = parse_structured_response(response_text, batch_blocks)
        translated_blocks_all.extend(batch_translated)

    # Reconstruct SRT
    output_lines = []
    for block in translated_blocks_all:
        output_lines.append(str(block["number"]))
        output_lines.append(block["timestamp"])
        output_lines.append(block["text"])
        output_lines.append("") # Empty line after block
        
    return "\n".join(output_lines)


def main():
    parser = argparse.ArgumentParser(
        description="Translate SRT files using various LLM providers with automatic chunking."
    )
    parser.add_argument("--srt", required=True, help="Path to input English SRT file")
    parser.add_argument("--out", required=False, help="Path to output translated SRT file (default: <srt_dir>/output/<filename_with_lang_provider>.srt)")
    available_langs = sorted(translate_srt.LANG_NAMES.keys())
    parser.add_argument(
        "--lang",
        required=True,
        help=(
            "Target language code (e.g., 'es', 'fr', 'de'), comma-separated list (e.g., 'es,fr,de'), "
            f"or 'all' to translate to all available languages. Available: {', '.join(available_langs)}"
        ),
    )
    parser.add_argument(
        "--provider",
        required=True,
        choices=["deepl", "openai", "gemini"],
        help="LLM provider to use",
    )
    parser.add_argument(
        "--no-experimental",
        action="store_true",
        help="Disable experimental languages for DeepL (default: enabled)",
    )

    args = parser.parse_args()

    # Parse language argument
    raw_lang_arg = args.lang.strip().lower()
    if not raw_lang_arg:
        parser.error("--lang must specify at least one language code or 'all'.")

    if raw_lang_arg == "all":
        # Exclude English from "all" since we're translating FROM English
        lang_codes = [lang for lang in available_langs if lang != "en"]
    else:
        lang_tokens = [token.strip().lower() for token in raw_lang_arg.split(",") if token.strip()]
        if not lang_tokens:
            parser.error("--lang must include at least one valid language code.")

        invalid = [code for code in lang_tokens if code not in available_langs]
        if invalid:
            parser.error(
                f"Invalid language code(s): {', '.join(invalid)}. "
                f"Available: {', '.join(available_langs)}"
            )

        # Remove duplicates while preserving order
        seen = set()
        lang_codes = []
        for code in lang_tokens:
            if code not in seen:
                seen.add(code)
                lang_codes.append(code)

    is_multi_lang = len(lang_codes) > 1

    # Get API key based on provider
    if args.provider == "deepl":
        api_key = os.getenv("DEEPL_API_KEY")
        if not api_key:
            raise RuntimeError("DEEPL_API_KEY not found in environment")
    elif args.provider == "openai":
        api_key = os.getenv("OPENAI_API_KEY")
        if not api_key:
            raise RuntimeError("OPENAI_API_KEY not found in environment")
    elif args.provider == "gemini":
        api_key = os.getenv("GEMINI_API_KEY")
        if not api_key:
            raise RuntimeError("GEMINI_API_KEY not found in environment")

    # Get OpenAI API key for timestamp repair (if available)
    repair_api_key = os.getenv("OPENAI_API_KEY")
    if not repair_api_key:
        print("⚠️  Warning: OPENAI_API_KEY not found - timestamp auto-repair will be disabled")
        print("   Set OPENAI_API_KEY environment variable to enable automatic timestamp repair\n")

    # Read input SRT once
    print(f"Reading SRT file: {args.srt}")
    srt_text = translate_srt.read_text(args.srt)

    # Process each language
    for lang_code in lang_codes:
        print(f"\n{'='*60}")
        print(f"Processing language: {lang_code} ({translate_srt.LANG_NAMES.get(lang_code, lang_code)})")
        print(f"{'='*60}")

        # Determine output path for this language
        if args.out:
            if is_multi_lang:
                # When translating multiple languages, modify the output path per language
                out_path = Path(args.out)
                if out_path.suffix == ".srt":
                    # Add language code before extension
                    output_path = str(out_path.parent / f"{out_path.stem}_{lang_code}{out_path.suffix}")
                else:
                    # Treat as directory
                    out_path.mkdir(exist_ok=True)
                    srt_filename = Path(args.srt).stem
                    output_path = str(out_path / f"{srt_filename}_{lang_code}_{args.provider}.srt")
            else:
                output_path = args.out
        else:
            # Build default output path: <srt_dir>/output/<filename_with_lang_provider>.srt
            srt_path = Path(args.srt)
            srt_dir = srt_path.parent
            srt_filename = srt_path.stem  # filename without extension
            srt_ext = srt_path.suffix  # .srt

            # Replace "-en" with output_<lang>_<provider>
            new_filename = srt_filename.replace("-en", f"__output_{lang_code}_{args.provider}")


            # Create output directory
            output_dir = srt_dir / "output"
            output_dir.mkdir(exist_ok=True)

            output_path = str(output_dir / f"{new_filename}{srt_ext}")

        print(f"Output: {output_path}")

        # Translate
        if args.provider == "deepl":
            print(f"Translating to {lang_code} using DeepL...")
            translated = translate_with_deepl(
                srt_text,
                lang_code,
                api_key,
                repair_api_key=repair_api_key,
                enable_experimental=not args.no_experimental,
            )
        elif args.provider == "openai":
            print(f"Translating to {lang_code} using OpenAI...")
            translated = translate_with_openai(srt_text, lang_code, api_key, repair_api_key=repair_api_key)
        elif args.provider == "gemini":
            print(f"Translating to {lang_code} using Gemini...")
            translated = translate_with_gemini(srt_text, lang_code, api_key, repair_api_key=repair_api_key)

        # Write output
        print(f"Writing translated SRT to: {output_path}")
        translate_srt.write_text(output_path, translated)
        print(f"✅ {lang_code} translation complete!")

    print(f"\n{'='*60}")
    print(f"✅ All translations complete! Processed {len(lang_codes)} language(s).")
    print(f"{'='*60}")


if __name__ == "__main__":
    main()
