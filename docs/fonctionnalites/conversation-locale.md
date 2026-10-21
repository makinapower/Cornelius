# Conversation locale

Par défaut, Cornelius converse avec l’API vocale d’OpenAI. La conversation locale la remplace par des modèles qui tournent dans la maison : la voix, le texte et les souvenirs ne la quittent plus, et aucune clé OpenAI n’est nécessaire. Cette page s’adresse à la personne qui installe le miroir. Elle a été pensée pour un Mac à puce Apple, avec [oMLX](https://github.com/jundot/omlx) pour le modèle de langage, et pour la parole soit [mlx-audio](https://github.com/Blaizzy/mlx-audio) sur le Mac, soit les services Whisper et Piper déjà en place pour Home Assistant (protocole Wyoming).

## Comment ça marche

Trois services locaux, chacun avec une API compatible OpenAI :

| Rôle | Service conseillé | Adresse par défaut |
|---|---|---|
| Transcrire ce que dit la personne | mlx-audio (Whisper large v3 turbo), ou Whisper de Home Assistant | `http://127.0.0.1:8001/v1`, ou `tcp://<adresse>:10300` |
| Comprendre, appeler les outils et répondre | oMLX, avec un modèle qui sait appeler des outils | `http://127.0.0.1:8000/v1` |
| Dire la réponse | mlx-audio (voix Kokoro `ff_siwis`), ou Piper de Home Assistant | `http://127.0.0.1:8001/v1`, ou `tcp://<adresse>:10200` |

Une adresse `http://` désigne une API compatible OpenAI (`/audio/transcriptions`, `/audio/speech`) ; une adresse `tcp://` désigne un service Wyoming, le protocole des modules vocaux de Home Assistant.

Le serveur de Cornelius détecte la fin de chaque phrase, la fait transcrire, envoie la conversation au modèle avec les outils du miroir (heure, météo, bus, souvenirs, cartes, Home Assistant, Hermes, vision, images), exécute lui-même les outils avec les mêmes vérifications qu’avec OpenAI, puis fait dire la réponse phrase par phrase. Le son du micro et la voix passent par le WebSocket `/audio` du miroir ; les satellites audio fonctionnent de la même façon.

## Installer (macOS)

1. Installez et lancez oMLX (application de la barre des menus ou `brew`), puis chargez un modèle qui sait appeler des outils, par exemple Qwen3 8B ou 14B en 4 bits. oMLX écoute sur le port 8000.
2. Installez la voix locale avec l’installateur de Cornelius :

   ```sh
   scripts/install-macos.sh --system-deps --local --launchd
   ```

   L’option `--local` installe `espeak-ng` (phonèmes français de la voix Kokoro) et mlx-audio dans un environnement séparé, `.venv-voice`. Elle ajoute `CORNELIUS_CONVERSATION=local` à `.env` s’il n’y a pas déjà de choix. Avec `--launchd`, le serveur de voix devient un troisième service, `fr.cornelius.voice` ; sans lui, `scripts/start.sh` le lance avec le reste.
3. Au premier usage, mlx-audio télécharge les modèles Whisper et Kokoro depuis Hugging Face : la première réponse peut donc prendre une minute.

## Avec Whisper et Piper de Home Assistant

Si Whisper et Piper tournent déjà pour l’assistant vocal de Home Assistant (modules complémentaires *Whisper* et *Piper*, ou conteneurs `wyoming-faster-whisper` et `wyoming-piper`), Cornelius peut s’en servir directement, sur le réseau local. Seul oMLX tourne alors sur le Mac : l’option `--local` de l’installateur et mlx-audio sont inutiles.

1. Vérifiez depuis le Mac que les deux ports répondent (remplacez l’adresse par celle de Home Assistant) :

   ```sh
   nc -vz 192.168.1.20 10300    # Whisper
   nc -vz 192.168.1.20 10200    # Piper
   ```

   Sur Home Assistant OS, ces ports sont ceux des modules complémentaires (onglet **Réseau** de chaque module) ; ils doivent rester ouverts sur l’hôte.
2. Ajoutez dans `.env` :

   ```sh
   CORNELIUS_CONVERSATION=local
   CORNELIUS_LOCAL_STT_URL=tcp://192.168.1.20:10300
   CORNELIUS_LOCAL_TTS_URL=tcp://192.168.1.20:10200
   # Facultatif : une voix Piper précise, sinon celle réglée dans le module Piper.
   # CORNELIUS_LOCAL_TTS_VOICE=fr_FR-siwis-medium
   ```

3. Redémarrez Cornelius.

Cornelius envoie la langue `fr` à Whisper à chaque phrase ; le modèle Whisper reste celui choisi dans le module (un modèle `small` ou plus grand comprend mieux le français que `tiny`). Le son passe en clair sur le réseau de la maison, comme pour l’assistant vocal de Home Assistant. On peut aussi mélanger : Whisper de Home Assistant et la voix de mlx-audio, ou l’inverse.

Sous Linux ou Windows, le principe est le même avec d’autres serveurs compatibles OpenAI (llama.cpp, Ollama, LM Studio, vLLM pour le modèle ; Speaches ou un autre serveur pour la parole) : renseignez leurs adresses dans `.env`.

## Réglages

Tous les réglages sont dans `.env`, lus au démarrage du serveur :

| Variable | Défaut | Effet |
|---|---|---|
| `CORNELIUS_CONVERSATION` | `openai` | `local` choisit la conversation locale. |
| `CORNELIUS_LOCAL_LLM_URL` | `http://127.0.0.1:8000/v1` | Adresse de l’API du modèle de langage (oMLX). |
| `CORNELIUS_LOCAL_LLM_MODEL` | vide | Modèle à utiliser ; vide, le premier que liste le serveur. |
| `CORNELIUS_LOCAL_LLM_API_KEY` | vide | Clé de l’API locale, si elle en demande une. |
| `CORNELIUS_LOCAL_AUDIO_URL` | `http://127.0.0.1:8001/v1` | Adresse commune de la transcription et de la voix (mlx-audio). |
| `CORNELIUS_LOCAL_STT_URL`, `CORNELIUS_LOCAL_TTS_URL` | celle du dessus | Adresses séparées : `http://…/v1` (API compatible OpenAI) ou `tcp://hôte:port` (Wyoming : Whisper, Piper). |
| `CORNELIUS_LOCAL_STT_MODEL` | `mlx-community/whisper-large-v3-turbo-asr-fp16` ; vide avec Wyoming | Modèle de transcription. Avec Wyoming, celui du service si vide. |
| `CORNELIUS_LOCAL_STT_LANGUAGE` | `fr` | Langue imposée à la transcription. |
| `CORNELIUS_LOCAL_TTS_MODEL` | `mlx-community/Kokoro-82M-bf16` | Modèle de voix. |
| `CORNELIUS_LOCAL_TTS_VOICE` | `ff_siwis` ; vide avec Wyoming | Voix : `ff_siwis` pour Kokoro, un nom Piper (`fr_FR-siwis-medium`, `fr_FR-tom-medium`…) avec Wyoming, sinon celle du service. |
| `CORNELIUS_LOCAL_TTS_LANG_CODE` | `f` | Langue de Kokoro (`f` : français) ; `non` pour ne pas l’envoyer à un autre serveur. |
| `CORNELIUS_LOCAL_TTS_SPEED` | `1` | Vitesse de la voix, de 0,5 à 2 (API compatible OpenAI seulement ; pour Piper, elle se règle dans le module). |

## Ce qui change par rapport à OpenAI

- **Tout reste dans la maison** : la transcription, les réponses et l’extraction des souvenirs passent par le même modèle local. La clé OpenAI ne sert plus qu’à la génération d’images OpenAI, si elle est choisie.
- **Pas de recherche web** : l’outil `web_search` est propre à OpenAI. Cornelius dit qu’il ne peut pas vérifier une actualité.
- **Tour par tour** : Cornelius n’écoute pas pendant qu’il parle (sinon il s’entendrait). On ne peut donc pas lui couper la parole ; on parle après sa réponse.
- **Plus lent** : chaque réponse attend la fin de la phrase (0,8 s de silence), la transcription, le modèle puis la première phrase de voix. Un petit modèle (8B en 4 bits) garde l’échange fluide.
- **Mot d’appel** : avec l’ouverture au mot « Cornelius », dites le mot, attendez que l’orbe écoute, puis faites votre demande. La phrase dite d’un seul souffle avec le mot d’appel n’est pas rejouée au modèle local.
- **Qualité** : elle dépend du modèle choisi. Un modèle qui appelle mal les outils inventera ou oubliera des cartes. Qwen3 et Gemma 3 sont de bons points de départ.

## Dépannage

| Symptôme | Cause probable |
|---|---|
| « Erreur Live » dès la première phrase, journal « LLM local : réponse refusée » ou « injoignable » | oMLX n’est pas lancé, pas sur le port 8000, ou aucun modèle n’est chargé. |
| Journal « Transcription locale refusée » ou « Synthèse vocale locale refusée » | mlx-audio n’est pas lancé (`data/run/logs/voice.err.log`), ou le modèle demandé n’a pas pu être téléchargé. |
| Journal « Transcription Wyoming injoignable » ou « Synthèse vocale Wyoming injoignable » | Mauvaise adresse ou port fermé : vérifiez avec `nc -vz`, et que le module Whisper ou Piper tourne. |
| « Synthèse vocale Wyoming : … » avec un nom de voix | La voix demandée n’existe pas dans Piper : laissez `CORNELIUS_LOCAL_TTS_VOICE` vide ou choisissez une voix française installée. |
| Voix muette ou mal prononcée | espeak-ng manque : `brew install espeak-ng`, puis redémarrez Cornelius. |
| Cornelius répond à du bruit | Les phrases inventées par Whisper sur un silence sont écartées, pas toutes ; éloignez le micro des haut-parleurs. |

## Voir aussi

- [Installer sous macOS](../installation/macos.md)
- [Configuration](../reference/configuration.md)
- [Mémoire](memoire.md)
- [Satellites audio](satellites.md)
