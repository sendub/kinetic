window.KINETIC_MANIFEST = {
  "schemaVersion": 1,
  "storyId": "branches-example",
  "title": "Branches example",
  "width": 1280,
  "height": 720,
  "items": [
    {
      "id": "intro-001",
      "type": "image",
      "file": "intro-001.jpg",
      "speaker": "Mei",
      "text": "You're early today."
    },
    {
      "id": "line-002",
      "type": "text",
      "text": "The afternoon stretched out ahead of us."
    },
    {
      "id": "meet-003",
      "type": "image",
      "file": "meet-003.jpg"
    },
    {
      "id": "cafe-004",
      "type": "image",
      "file": "cafe-004.jpg",
      "text": "We took the corner table at the cafe."
    },
    {
      "id": "cafe-005",
      "type": "image",
      "file": "cafe-005.jpg",
      "speaker": "Mei",
      "text": "They're closing the terrace soon."
    },
    {
      "id": "tea-006",
      "type": "image",
      "file": "tea-006.jpg",
      "text": "We stayed for tea while the lights came on."
    },
    {
      "id": "tea-007",
      "type": "image",
      "file": "tea-007.jpg",
      "text": "We left before the terrace chairs went in."
    },
    {
      "id": "cafe-008",
      "type": "image",
      "file": "cafe-008.jpg",
      "text": "Back inside, the rain had started."
    },
    {
      "id": "home-009",
      "type": "image",
      "file": "home-009.jpg",
      "text": "We walked straight home under one umbrella."
    },
    {
      "id": "home-010",
      "type": "text",
      "speaker": "Mei",
      "text": "Same time tomorrow?"
    },
    {
      "id": "epilogue-011",
      "type": "image",
      "file": "epilogue-011.jpg",
      "text": "Whatever the afternoon held, the evening was ours."
    }
  ],
  "branches": [
    {
      "id": "cafe-choice",
      "after": "cafe-005",
      "prompt": "Stay for tea, or leave?",
      "routes": [
        {
          "id": "stay",
          "label": "Stay for tea",
          "start": "tea-006",
          "end": "tea-006"
        },
        {
          "id": "leave",
          "label": "Leave before they close",
          "start": "tea-007",
          "end": "tea-007"
        }
      ],
      "continuingRoute": "stay",
      "continueAt": "cafe-008"
    },
    {
      "id": "afternoon",
      "after": "meet-003",
      "prompt": "How does the afternoon go?",
      "routes": [
        {
          "id": "cafe",
          "label": "To the cafe",
          "start": "cafe-004",
          "end": "cafe-008",
          "result": "ending"
        },
        {
          "id": "home",
          "label": "Straight home",
          "start": "home-009",
          "end": "home-010"
        }
      ],
      "continuingRoute": "home",
      "continueAt": "epilogue-011"
    }
  ]
};
