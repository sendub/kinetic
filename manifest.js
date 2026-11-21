window.KINETIC_MANIFEST = {
  "schemaVersion": 1,
  "storyId": "kinetic-demo",
  "title": "Kinetic demo",
  "width": 960,
  "height": 540,
  "characters": {
    "Ines": {
      "nameColor": "#7fd6c2",
      "textColor": "#f6dca8"
    }
  },
  "items": [
    {
      "id": "intro-title",
      "type": "image",
      "file": "intro-title.jpg",
      "text": "Kinetic demo. Every line explains what you are seeing. Space shows the next item; the mouse wheel scrolls back and forth through what you have read; Esc shows the keys and settings."
    },
    {
      "id": "text-speech",
      "type": "image",
      "file": "text-speech.jpg",
      "speaker": "Mei",
      "text": "Spoken dialogue: the speaker's name, Mei, sits above it."
    },
    {
      "id": "text-thought",
      "type": "text",
      "speaker": "Mei",
      "thought": true,
      "text": "A thought: unspoken, so it is drawn differently from speech."
    },
    {
      "id": "text-narration",
      "type": "text",
      "text": "Narration has no name. Press h to hide all text; press h again to bring it back."
    },
    {
      "id": "text-bare",
      "type": "image",
      "file": "text-bare.jpg"
    },
    {
      "id": "anim-orbit",
      "type": "animation",
      "frames": [
        "anim-orbit.f000.jpg",
        "anim-orbit.f001.jpg",
        "anim-orbit.f002.jpg",
        "anim-orbit.f003.jpg"
      ],
      "fps": 8,
      "loopCount": 2,
      "text": "An animation: four pictures at 8 per second, shown twice, then it rests on the last one."
    },
    {
      "id": "video-chain",
      "type": "video",
      "file": "video-chain.mp4",
      "poster": "video-chain.poster.jpg",
      "durationSeconds": 2.0,
      "text": "A video. It keeps looping while this line and the next two are read."
    },
    {
      "id": "video-chain-2",
      "type": "text",
      "speaker": "Theo",
      "text": "Second line of the chain: the same clip plays on underneath."
    },
    {
      "id": "video-chain-3",
      "type": "text",
      "thought": true,
      "text": "Third line, a thought. Scroll back onto the video to see its still poster."
    },
    {
      "id": "chain-still",
      "type": "image",
      "file": "chain-still.jpg"
    },
    {
      "id": "chain-still-2",
      "type": "text",
      "speaker": "Theo",
      "text": "Lines can chain over a still picture too."
    },
    {
      "id": "chain-still-3",
      "type": "text",
      "thought": true,
      "text": "A thought over the same still."
    },
    {
      "id": "video-loops",
      "type": "video",
      "file": "video-loops.mp4",
      "poster": "video-loops.poster.jpg",
      "durationSeconds": 1.0,
      "loopCount": 3,
      "text": "Loop count 3: three passes."
    },
    {
      "id": "video-hold",
      "type": "video",
      "file": "video-hold.webm",
      "poster": "video-hold.poster.jpg",
      "durationSeconds": 2.0,
      "holdSeconds": 4,
      "text": "A WebM clip held 4 s, looping in the background."
    },
    {
      "id": "range-a",
      "type": "video",
      "file": "range-clip.mp4",
      "poster": "range-a.poster.jpg",
      "durationSeconds": 2.0,
      "startSeconds": 0.0,
      "endSeconds": 1.0,
      "loopCount": 1,
      "text": "One video file, first range: seconds 0 to 1 (green, then violet)."
    },
    {
      "id": "range-b",
      "type": "video",
      "file": "range-clip.mp4",
      "poster": "range-b.poster.jpg",
      "durationSeconds": 2.0,
      "startSeconds": 1.0,
      "endSeconds": 2.0,
      "loopCount": 2,
      "loopStartSeconds": 1.5,
      "text": "Same file, seconds 1 to 2, shown twice. The repeat restarts at 1.5 s, so it skips the rust part."
    },
    {
      "id": "look-dissolve",
      "type": "image",
      "file": "look-dissolve.jpg",
      "transition": {
        "kind": "dissolve",
        "seconds": 1
      },
      "text": "This picture dissolved in over the one before, in one second. A transition never holds up the text."
    },
    {
      "id": "look-speaker",
      "type": "text",
      "speaker": "Ines",
      "text": "Ines has colours of her own: one for her name, one for her lines."
    },
    {
      "id": "look-tags",
      "type": "text",
      "speaker": "Ines",
      "text": "Ren'Py text tags work too: {i}italic{/i} and {b}bold{/b}."
    },
    {
      "id": "look-fade",
      "type": "image",
      "file": "look-fade.jpg",
      "transition": {
        "kind": "fade",
        "out": 0.5,
        "hold": 0.25,
        "in": 0.5
      },
      "text": "A fade: the last picture went to black, the black held a moment, then this one came in."
    },
    {
      "id": "floor-title",
      "type": "image",
      "file": "floor-title.jpg",
      "text": "Next: a clip with a minimum play time of 4.5 s. In auto mode its three short lines read fast, then the last waits for the clip. Space and tab never wait."
    },
    {
      "id": "floor-clip",
      "type": "video",
      "file": "floor-clip.mp4",
      "poster": "floor-clip.poster.jpg",
      "durationSeconds": 6.0,
      "minPlaySeconds": 4.5,
      "text": "Short line one."
    },
    {
      "id": "floor-2",
      "type": "text",
      "text": "Short line two."
    },
    {
      "id": "floor-3",
      "type": "text",
      "text": "Line three waits."
    },
    {
      "id": "branch-title",
      "type": "image",
      "file": "branch-title.jpg",
      "text": "Next: a decision. Route 1 continues the story and holds a nested decision; Route 2 is an ending. After a route ends you can pick another."
    },
    {
      "id": "branch-lead",
      "type": "image",
      "file": "branch-lead.jpg",
      "text": "Shared lead-in: every route starts after this. The decision opens when you press Space here."
    },
    {
      "id": "branch-decide",
      "type": "image",
      "file": "branch-decide.jpg"
    },
    {
      "id": "route1-start",
      "type": "image",
      "file": "route1-start.jpg",
      "speaker": "Mei",
      "text": "Route 1, first line. A nested decision opens after the next line."
    },
    {
      "id": "route1-nest",
      "type": "text",
      "speaker": "Theo",
      "text": "Route 1, second line: the nested decision hangs off this one."
    },
    {
      "id": "nest-continue",
      "type": "text",
      "text": "Nested 1a: when it ends, Route 1 carries on."
    },
    {
      "id": "nest-return",
      "type": "text",
      "text": "Nested 1b: when it ends, the nested decision is offered again."
    },
    {
      "id": "route1-end",
      "type": "text",
      "text": "Route 1 again, after the nested decision. Its end leads to the shared ending section."
    },
    {
      "id": "route2-start",
      "type": "image",
      "file": "route2-start.jpg",
      "speaker": "Mei",
      "text": "Route 2: a separate path that does not rejoin the story."
    },
    {
      "id": "route2-end",
      "type": "text",
      "text": "Route 2 ends here: this is an ending. Space offers the routes again."
    },
    {
      "id": "after-start",
      "type": "image",
      "file": "after-start.jpg",
      "text": "Shared aftermath: reached by finishing Route 1. Return to main route jumps here once Route 1 is done."
    },
    {
      "id": "after-end",
      "type": "text",
      "text": "The end. Also try: u for unseen content, e for the end of what you have read, b and t for bookmarks, Esc for the keys and settings, a for auto-play, tab to skip what you have read."
    }
  ],
  "branches": [
    {
      "id": "nested",
      "after": "route1-nest",
      "prompt": "Nested decision inside Route 1:",
      "routes": [
        {
          "id": "nest-a",
          "label": "1a: carries on with Route 1",
          "start": "nest-continue",
          "end": "nest-continue"
        },
        {
          "id": "nest-b",
          "label": "1b: comes back to this decision",
          "start": "nest-return",
          "end": "nest-return",
          "result": "return"
        }
      ],
      "continuingRoute": "nest-a",
      "continueAt": "route1-end"
    },
    {
      "id": "outer",
      "after": "branch-decide",
      "prompt": "Demo decision: which route?",
      "routes": [
        {
          "id": "route1",
          "label": "Route 1: continues the story",
          "start": "route1-start",
          "end": "route1-end",
          "result": "return"
        },
        {
          "id": "route2",
          "label": "Route 2: an ending",
          "start": "route2-start",
          "end": "route2-end",
          "result": "ending"
        }
      ],
      "continuingRoute": "route1",
      "continueAt": "after-start"
    }
  ]
};
