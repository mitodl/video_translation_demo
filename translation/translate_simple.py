#!/usr/bin/env python3
"""
Simple SRT translation script with automatic chunking on token limit errors.
Refactored to use 'srt' library and class-based providers.

Supports multiple LLM providers: gemini, openai, deepl
Automatically retries with smaller chunks when token limits are exceeded.
"""

import argparse
from json import load
import logging
import math
import os
import re
import sys
from abc import ABC, abstractmethod
from pathlib import Path
from typing import List, Optional, Dict, Any, Generator

import deepl
import srt
from dotenv import load_dotenv
from litellm import completion
from openai import OpenAI

# Load environment variables
load_dotenv()

logging.basicConfig(level=logging.INFO, format="%(message)s")
log = logging.getLogger(__name__)

# Constants
DEEPL_LANG_CODES = {
    "fr": "FR", "de": "DE", "es": "ES", "pt": "PT-PT", "pt-br": "PT-BR",
    "hi": "HI", "ar": "AR", "zh": "ZH", "kr": "KO", "ja": "JA",
    "id": "ID", "ru": "RU", "el": "EL", "tr": "TR", "sq": "SQ",
}

LANG_NAMES = {
    "en": "English", "de": "Deutsch", "es": "Español", "fr": "Français",
    "pt-br": "Português – Brasil", "ru": "Русский", "hi": "हिंदी",
    "el": "ελληνικά", "ja": "日本語", "ar": "العربية", "zh": "中文",
    "tr": "Türkçe", "sq": "Shqip", "kr": "한국어", "id": "Bahasa Indonesia",
}

# Default Models
DEFAULT_OPENAI_MODEL = os.getenv("OPENAI_MODEL", "gpt-5.2")
DEFAULT_GEMINI_MODEL = os.getenv("GEMINI_MODEL", "gemini-3-pro-preview")

NO_TRANSLATION = "[NO TRANSLATION]"

def load_srt(path: str) -> List[srt.Subtitle]:
    """Read and parse an SRT file."""
    with open(path, "r", encoding="utf-8") as f:
        content = f.read()
    return list(srt.parse(content))


def save_srt(path: str, subtitles: List[srt.Subtitle]) -> None:
    """Write subtitles to an SRT file."""
    content = srt.compose(subtitles)
    with open(path, "w", encoding="utf-8") as f:
        f.write(content)


def load_glossary(lang_code: str, base_dir: str = None) -> str:
    """
    Load a language glossary from glossaries/<base_dir>/<lang_code>.txt.
    """
    path = os.path.join(base_dir, f"{lang_code}.txt")
    if not os.path.exists(path):
        log.error("Glossary file not found: %s", path)
        return ""
    with open(path, "r", encoding="utf-8-sig") as f:
        return f.read().strip() 

class TranslationProvider(ABC):
    """Abstract base class for translation providers."""

    def __init__(self, api_key: str, repair_api_key: Optional[str] = None):
        self.api_key = api_key
        self.repair_api_key = repair_api_key

    def translate(
            self,
            subtitles: List[srt.Subtitle],
            target_lang: str,
            glossary: Optional[str] = None
        ) -> List[srt.Subtitle]:
        """Public interface for translation with validation and repair."""
        translated = self._translate_subtitles(subtitles, target_lang, glossary=glossary)

        if self._validate_timestamps(subtitles, translated):
            log.info("  ✓ Timestamps validated successfully")
            return translated

        log.warning("Timestamp validation failed - attempting automatic repair...")
        repaired = self._repair_timestamps_with_llm(subtitles, translated, target_lang)

        if self._validate_timestamps(subtitles, repaired):
            log.info("Timestamps successfully repaired!")
            return repaired
        else:
            log.warning("Repair attempt did not fully fix timestamps, using repaired version anyway")
            return repaired

    @abstractmethod
    def _translate_subtitles(
        self, 
        subtitles: List[srt.Subtitle], 
        target_lang: str,
        glossary: Optional[str] = None
    ) -> List[srt.Subtitle]:
        """Actual translation implementation."""
        pass



    def _validate_timestamps(self, original: List[srt.Subtitle], translated: List[srt.Subtitle]) -> bool:
        """Validate that timestamps and cue numbers are preserved."""
        issues = []
        if len(original) != len(translated):
            issues.append(f"Cue count mismatch: original {len(original)}, translated {len(translated)}")

        for i, (orig, trans) in enumerate(zip(original, translated)):
            if orig.index != trans.index:
                issues.append(f"Cue {i+1}: index mismatch ({orig.index} vs {trans.index})")
            if orig.start != trans.start or orig.end != trans.end:
                issues.append(f"Cue {i+1}: timestamp mismatch")
            if orig.content.strip() and not trans.content.strip():
                issues.append(f"Cue {i+1}: translation is BLANK")

        if issues:
            log.warning("Translation validation found issues:")
            for issue in issues[:10]:
                log.warning("  - %s", issue)
            if len(issues) > 10:
                log.warning("  ... and %s more issues", len(issues) - 10)
            return False
        return True

    def v(self, original: List[srt.Subtitle], misaligned: List[srt.Subtitle], target_lang: str) -> List[srt.Subtitle]:
        """Repair misaligned timestamps using OpenAI."""
        if not self.repair_api_key:
            log.warning("   No repair API key available, skipping repair.")
            return misaligned

        log.info("  🔧 Repairing timestamps using LLM...")
        client = OpenAI(api_key=self.repair_api_key)
        
        repaired_subtitles = []
        batch_size = 50
        total_batches = math.ceil(len(original) / batch_size)
        
        for i in range(total_batches):
            start = i * batch_size
            end = min(len(original), start + batch_size)
            original_batch = original[start:end]
            
            # Get corresponding translated batch with overlap
            overlap = 5
            t_start = max(0, start - overlap)
            t_end = min(len(misaligned), end + overlap)
            misaligned_batch = misaligned[t_start:t_end]
            
            original_text = srt.compose(original_batch)
            misaligned_text = srt.compose(misaligned_batch)
            
            log.info("  Repairing chunk %s/%s...", i + 1, total_batches)

            system_prompt = (
                f"You repair timestamp alignment problems in SRT subtitles translated to {target_lang}.\n"
                "Each request contains a subset of the original SRT and the corresponding translated output.\n"
                "For the cues shown, copy the cue numbers and timestamps EXACTLY from the original section\n"
                "and rewrite the translated text so it aligns 1:1 with those cues.\n"
                "Return only a valid SRT segment for the provided cues."
            )
            
            user_prompt = (
                f"You are fixing cues {original_batch[0].index}-{original_batch[-1].index}.\n\n"
                "ORIGINAL ENGLISH SRT WITH CORRECT TIMESTAMPS:\n"
                "```\n"
                f"{original_text}\n"
                "```\n\n"
                "TRANSLATED SRT WITH INCORRECT TIMESTAMPS:\n"
                "```\n"
                f"{misaligned_text}\n"
                "```\n\n"
                "Return ONLY the corrected SRT for the cues shown in the original section."
            )
            
            try:
                response = client.chat.completions.create(
                    model="gpt-4o",
                    messages=[
                        {"role": "system", "content": system_prompt},
                        {"role": "user", "content": user_prompt},
                    ],
                    temperature=0.0,
                )
                content = response.choices[0].message.content.strip()
                # Remove markdown code blocks if present
                if content.startswith("```"):
                    # Remove first line (```srt or ```) and last line (```)
                    lines = content.splitlines()
                    if lines[0].startswith("```"):
                        lines.pop(0)
                    if lines and lines[-1].startswith("```"):
                        lines.pop()
                    content = "\n".join(lines)
                
                repaired_batch = list(srt.parse(content))
                repaired_subtitles.extend(repaired_batch)
                
            except Exception as e:
                log.error("  Failed to repair batch %s: %s", i + 1, e)
                # Fallback: use original timestamps with empty text to preserve structure
                for sub in original_batch:
                    repaired_subtitles.append(srt.Subtitle(
                        index=sub.index, start=sub.start, end=sub.end, content=""
                    ))

        return repaired_subtitles


class DeepLProvider(TranslationProvider):
    def __init__(self, api_key: str, repair_api_key: Optional[str] = None):
        super().__init__(api_key, repair_api_key)
        self.enable_experimental = True
        self.translator = deepl.Translator(auth_key=api_key)

    def _translate_subtitles(self, subtitles: List[srt.Subtitle], target_lang: str, **kwargs) -> List[srt.Subtitle]:
        target_code = DEEPL_LANG_CODES.get(target_lang.lower())
        if not target_code:
            raise ValueError(f"DeepL does not support language '{target_lang}'.")

        extra_params = {"enable_beta_languages": True}
        
        translated_subtitles = []
        batch_size = len(subtitles)
        
        i = 0
        while i < len(subtitles):
            batch = subtitles[i : i + batch_size]
            log.info("  Translating batch starting at ID %s (%s blocks)...", batch[0].index, len(batch))

            try:
                # Construct XML payload to bypass 50-item limit and ensure alignment
                # Using simple tags <s>text</s>
                payload_parts = ["<d>"]
                for sub in batch:
                    # Escape XML special chars in content
                    safe_content = sub.content.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")
                    payload_parts.append(f'<s i="{sub.index}">{safe_content}</s>')
                payload_parts.append("</d>")
                payload = "".join(payload_parts)

                # Check size limit roughly (128KB)
                if len(payload.encode('utf-8')) > 128000:
                     raise ValueError("Payload too large for DeepL API")

                result = self.translator.translate_text(
                    payload,
                    source_lang="EN",
                    target_lang=target_code,
                    preserve_formatting=True,
                    tag_handling="xml",
                    split_sentences="nonewlines",
                    extra_body_parameters=extra_params,
                )
                
                translated_xml = result.text
                
                # Parse XML back
                # Pattern: <s i="(\d+)">(.*?)</s>
                pattern = re.compile(r'<s i="(\d+)">(.*?)</s>', re.DOTALL)
                matches = pattern.findall(translated_xml)
                
                if len(matches) != len(batch):
                    log.warning("  DeepL returned %d items, expected %d. Retrying with smaller batch.", len(matches), len(batch))
                    raise ValueError("Count mismatch in DeepL response")

                # Map back
                batch_map = {str(sub.index): sub for sub in batch}
                
                for index_str, content in matches:
                    # Unescape XML (Order matters: &amp; last)
                    content = content.replace("&lt;", "<").replace("&gt;", ">").replace("&amp;", "&")
                    
                    if index_str in batch_map:
                        original = batch_map[index_str]
                        translated_subtitles.append(srt.Subtitle(
                            index=original.index,
                            start=original.start,
                            end=original.end,
                            content=content.strip()
                        ))
                
                i += batch_size

            except Exception as e:
                error_str = str(e).lower()
                # Handle size limits or other retryable errors
                if batch_size <= 1:
                    log.error("Failed even with batch size 1: %s", e)
                    raise
                
                log.warning("  Error: %s. Reducing batch size...", e)
                batch_size = max(1, batch_size // 2)
                continue

        return translated_subtitles


class LLMProvider(TranslationProvider):
    """Base class for LLM-based providers (OpenAI, Gemini) that use structured prompting."""

    def __init__(self, api_key: str, repair_api_key: Optional[str] = None, model: str = None):
        super().__init__(api_key, repair_api_key)
        self.model = model

    def _get_system_prompt(self, target_lang: str, glossary: Optional[str] = None) -> str:
        lang_name = LANG_NAMES.get(target_lang, target_lang)
        base_prompt = (
            f"You are a professional subtitle translator. Translate the following English subtitles to {lang_name}.\n\n"
            "INPUT FORMAT:\n"
            ":::ID:::\n"
            "Text to translate\n\n"
            "OUTPUT FORMAT (exactly):\n"
            ":::ID:::\n"
            "Translated text\n\n"
            "RULES:\n"
            "1. Preserve ALL :::ID::: markers exactly as given.\n"
            "2. Every input ID MUST appear in output with its translation.\n"
            "3. One ID = one translation. NEVER merge or split content across IDs.\n"
            "4. Keep proper nouns, brand names, and acronyms unchanged (e.g., 'HAIM', 'IBM Watson', 'XGBoost').\n"
            "5. Use natural phrasing appropriate for subtitles.\n"
        )
        if glossary:
            log.info("Attempting to load glossary from: %s", glossary)
            terms = load_glossary(target_lang, glossary)
            if terms:
                base_prompt += f"6. Apply these glossary terms where applicable:\n{terms}\n"
        return base_prompt


    def _parse_structured_response(self, response_text: str, original_batch: List[srt.Subtitle]) -> List[srt.Subtitle]:
        """Parse the structured response and map back to original blocks."""
        # Create a map of ID -> Original Subtitle for O(1) access
        translated_subs = []
        
        # Regex to find :::ID::: markers
        pattern = re.compile(r":::(\d+):::\s*(.*?)(?=(?::::\d+:::|$))", re.DOTALL)
        matches = pattern.findall(response_text)
        
        found_ids = set()
        
        # Temporary storage for parsed translations
        parsed_translations = {}

        for cue_num, text in matches:
            cue_num = cue_num.strip()
            parsed_translations[cue_num] = text.strip()
            found_ids.add(cue_num)
            
        # Reconstruct list in original order
        for sub in original_batch:
            cue_num = str(sub.index)
            if cue_num in parsed_translations:
                translated_subs.append(srt.Subtitle(
                    index=sub.index,
                    start=sub.start,
                    end=sub.end,
                    content=parsed_translations[cue_num]
                ))
            else:
                log.warning("  Warning: Block %s missing in translation response. Leaving empty.", cue_num)
                translated_subs.append(srt.Subtitle(
                    index=sub.index,
                    start=sub.start,
                    end=sub.end,
                    content=""
                ))
                
        return translated_subs

    def _call_llm(self, system_prompt: str, user_payload: str, **kwargs) -> str:
        messages = [
            {"role": "system", "content": system_prompt},
            {"role": "user", "content": user_payload},
        ]
        response = completion(
            model=self.model,
            messages=messages,
            api_key=self.api_key,
            **kwargs
        )
        return response.choices[0].message.content.strip()

    def _translate_subtitles(
            self, 
            subtitles: List[srt.Subtitle], 
            target_lang: str,
            glossary: Optional[str] = None
        ) -> List[srt.Subtitle]:
        system_prompt = self._get_system_prompt(target_lang, glossary=glossary)
        
        # Dynamic batching, start with all subtitles
        translated_subtitles = []
        batch_size = len(subtitles) # Start with all subtitles
        
        i = 0
        while i < len(subtitles):
            batch = subtitles[i : i + batch_size]
            
            # Construct payload
            payload_parts = []
            for sub in batch:
                payload_parts.append(f":::{sub.index}:::")
                payload_parts.append(sub.content)
                payload_parts.append("")
            payload = "\n".join(payload_parts)
            log.info("  Translating batch starting at ID %s (%s blocks)...", batch[0].index, len(batch))
            
            try:
                response_text = self._call_llm(system_prompt, payload)
                batch_translated = self._parse_structured_response(response_text, batch)
                translated_subtitles.extend(batch_translated)
                i += batch_size
                
            except Exception as e:
                error_str = str(e).lower()
                if any(term in error_str for term in ["token", "quota", "limit", "too large", "context_length_exceeded", "503", "timeout"]):
                    if batch_size <= 1:
                        log.error("Failed even with batch size 1: %s", e)
                        raise
                    
                    log.warning("   Error: %s. Reducing batch size...", e)
                    batch_size = max(1, batch_size // 2)
                    continue # Retry same index with smaller batch
                else:
                    raise

        return translated_subtitles


class OpenAIProvider(LLMProvider):
    def __init__(self, api_key: str, repair_api_key: Optional[str] = None, model: str = DEFAULT_OPENAI_MODEL):
        super().__init__(api_key, repair_api_key, f"openai/{model}")

    def _call_llm(self, system_prompt: str, user_payload: str) -> str:
        return super()._call_llm(system_prompt, user_payload, reasoning_effort="low")


class GeminiProvider(LLMProvider):
    def __init__(self, api_key: str, repair_api_key: Optional[str] = None, model: str = DEFAULT_GEMINI_MODEL):
        super().__init__(api_key, repair_api_key, f"gemini/{model}")

    def _call_llm(self, system_prompt: str, user_payload: str) -> str:
        return super()._call_llm(system_prompt, user_payload)


def main():
    parser = argparse.ArgumentParser(description="Translate SRT files using various LLM providers.")
    parser.add_argument("--srt", required=True, help="Path to input English SRT file")
    parser.add_argument("--out", required=False, help="Path to output translated SRT file")
    parser.add_argument("--lang", required=True, help="Target language code(s), comma-separated or 'all'")
    parser.add_argument("--provider", required=True, choices=["deepl", "openai", "gemini"], help="LLM provider")
    parser.add_argument("--model", help="Override default model name")
    parser.add_argument("--glossary", required=False, help="Subfolder to glossary file")

    args = parser.parse_args()

    # Parse languages
    available_langs = sorted(LANG_NAMES.keys())
    if args.lang.lower() == "all":
        lang_codes = [l for l in available_langs if l != "en"]
    else:
        lang_codes = [l.strip().lower() for l in args.lang.split(",") if l.strip()]

    # Setup Provider
    provider_name = args.provider
    repair_key = os.getenv("OPENAI_API_KEY")
    glossary = args.glossary


    provider: TranslationProvider
    if provider_name == "deepl":
        key = os.getenv("DEEPL_API_KEY")
        if not key: raise RuntimeError("DEEPL_API_KEY not found")
        provider = DeepLProvider(key, repair_key)
        
    elif provider_name == "openai":
        key = os.getenv("OPENAI_API_KEY")
        if not key: raise RuntimeError("OPENAI_API_KEY not found")
        model = args.model or DEFAULT_OPENAI_MODEL
        provider = OpenAIProvider(key, repair_key, model)
        
    elif provider_name == "gemini":
        key = os.getenv("GEMINI_API_KEY")
        if not key: raise RuntimeError("GEMINI_API_KEY not found")
        model = args.model or DEFAULT_GEMINI_MODEL
        provider = GeminiProvider(key, repair_key, model)
    else:
        raise ValueError(f"Unknown provider: {provider_name}")

    # Read Input
    log.info("Reading SRT file: %s", args.srt)
    subtitles = load_srt(args.srt)

    # Process Languages
    for lang_code in lang_codes:
        log.info("=" * 60)
        log.info("Processing language: %s", lang_code)
        
        # Determine output path
        if args.out:
            if len(lang_codes) > 1:
                # If multiple languages, append code to filename
                p = Path(args.out)
                out_path = p.parent / f"{p.stem}_{lang_code}{p.suffix}"
            else:
                out_path = Path(args.out)
        else:
            # Default path logic
            p = Path(args.srt)
            suffix = f"__output_{lang_code}_{provider_name}"
            stem = p.stem[:-3] if p.stem.endswith("-en") else p.stem
            out_path = p.parent / "output" / f"{stem}{suffix}.srt"
            
        out_path.parent.mkdir(parents=True, exist_ok=True)
        
        try:
            translated_subs = provider.translate(subtitles, lang_code, glossary=glossary)
            log.info("Writing to: %s", out_path)
            save_srt(str(out_path), translated_subs)
            log.info("%s translation complete!", lang_code)
        except Exception as e:
            log.error("Failed to translate %s: %s", lang_code, e)

    log.info("=" * 60)
    log.info("All tasks complete.")

if __name__ == "__main__":
    main()
