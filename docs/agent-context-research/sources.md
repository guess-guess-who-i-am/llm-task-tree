# Sources and local downloads

## Downloaded and PDF-header verified

- `papers/lost-in-the-middle.pdf` — Liu et al., *Lost in the Middle: How Language Models Use Long Contexts*, TACL 2024. Source: https://aclanthology.org/2024.tacl-1.9/
- `papers/reflexion.pdf` — Shinn et al., *Reflexion: Language Agents with Verbal Reinforcement Learning*, NeurIPS 2023. Source: https://proceedings.neurips.cc/paper_files/paper/2023/hash/1b44b878bb782e6954cd888628510e90-Abstract-Conference.html
- `papers/memgpt.pdf` — Packer et al., *MemGPT: Towards LLMs as Operating Systems*, arXiv:2310.08560. Source: https://arxiv.org/abs/2310.08560
- `papers/opro.pdf` — Yang et al., *Large Language Models as Optimizers*, ICLR 2024, arXiv:2309.03409. Source: https://arxiv.org/abs/2309.03409

Extracted text is in `text/*.txt` for local search. Check each paper's license before redistribution.

## Reviewed online; PDF download still pending

- Park et al., *Generative Agents: Interactive Simulacra of Human Behavior*, UIST 2023: https://arxiv.org/abs/2304.03442
- Zhao et al., *ExpeL: LLM Agents Are Experiential Learners*, AAAI 2024: https://ojs.aaai.org/index.php/AAAI/article/view/29936
- Khattab et al., *DSPy: Compiling Declarative Language Model Calls into Self-Improving Pipelines*, ICLR 2024: https://openreview.net/forum?id=sY5N0zY5Od

## Official and high-quality engineering guidance

- OpenAI Codex, AGENTS.md guide: https://developers.openai.com/codex/guides/agents-md
- Anthropic, *Effective context engineering for AI agents*: https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents
- GitHub, *How to write a great agents.md: Lessons from over 2,500 repositories*: https://github.blog/ai-and-ml/github-copilot/how-to-write-a-great-agents-md-lessons-from-over-2500-repositories/

## Download notes

- The installed arXiv skill was missing its declared `scienceskillscommon` package, so its downloader failed before network access.
- Direct official downloads were retried with validation. Four PDFs succeeded; ExpeL, DSPy, and Generative Agents were blocked by TLS/403 behavior in this environment and remain link-only.

