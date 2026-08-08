{
  "rules": {
    ".read": false,
    ".write": false,

    "rooms": {
      ".read": "auth != null",

      "$roomId": {
        ".write": "auth != null && ((!data.exists() && newData.child('hostUid').val() === auth.uid) || (data.exists() && !newData.exists() && data.child('hostUid').val() === auth.uid))",

        "name": {
          ".validate": "newData.isString() && newData.val().length > 0 && newData.val().length <= 40"
        },
        "hostUid": {
          ".write": "auth != null && data.val() === auth.uid",
          ".validate": "newData.isString() && newData.val().length > 0 && newData.val().length <= 128"
        },
        "createdAt": {
          ".validate": "newData.isNumber() && newData.val() > 0"
        },

        "state": {
          ".write": "auth != null && root.child('rooms').child($roomId).child('hostUid').val() === auth.uid",
          ".validate": "newData.isString() && newData.val().matches(/^(lobby|voting|drawing|playing|ended)$/)"
        },
        "countdown": {
          ".write": "auth != null && root.child('rooms').child($roomId).child('hostUid').val() === auth.uid",
          ".validate": "newData.val() === null || (newData.isNumber() && newData.val() >= 0 && newData.val() <= 999)"
        },
        "hidePhaseCountdown": {
          ".write": "auth != null && root.child('rooms').child($roomId).child('hostUid').val() === auth.uid",
          ".validate": "newData.val() === null || (newData.isNumber() && newData.val() >= 0 && newData.val() <= 999)"
        },
        "roundCountdown": {
          ".write": "auth != null && root.child('rooms').child($roomId).child('hostUid').val() === auth.uid",
          ".validate": "newData.val() === null || (newData.isNumber() && newData.val() >= 0 && newData.val() <= 999)"
        },
        "drawCountdown": {
          ".write": "auth != null && root.child('rooms').child($roomId).child('hostUid').val() === auth.uid",
          ".validate": "newData.val() === null || (newData.isNumber() && newData.val() >= 0 && newData.val() <= 999)"
        },
        "postInfectionCountdown": {
          ".write": "auth != null && root.child('rooms').child($roomId).child('hostUid').val() === auth.uid",
          ".validate": "newData.val() === null || (newData.isNumber() && newData.val() >= 0 && newData.val() <= 999)"
        },
        "voteCountdown": {
          ".write": "auth != null && root.child('rooms').child($roomId).child('hostUid').val() === auth.uid",
          ".validate": "newData.val() === null || (newData.isNumber() && newData.val() >= 0 && newData.val() <= 999)"
        },
        "votePhase": {
          ".write": "auth != null && root.child('rooms').child($roomId).child('hostUid').val() === auth.uid",
          ".validate": "newData.isString() && newData.val().length <= 16"
        },
        "startRequested": {
          ".write": "auth != null && root.child('rooms').child($roomId).child('hostUid').val() === auth.uid",
          ".validate": "newData.val() === null || newData.isBoolean() || newData.isNumber()"
        },
        "gameMode": {
          ".write": "auth != null && root.child('rooms').child($roomId).child('hostUid').val() === auth.uid",
          ".validate": "newData.isString() && newData.val().matches(/^(classic|infection|team)$/)"
        },
        "selectedMap": {
          ".write": "auth != null && root.child('rooms').child($roomId).child('hostUid').val() === auth.uid",
          ".validate": "newData.isNumber() && newData.val() >= 0 && newData.val() <= 20"
        },
        "seekerUid": {
          ".write": "auth != null && root.child('rooms').child($roomId).child('hostUid').val() === auth.uid",
          ".validate": "newData.val() === null || (newData.isString() && newData.val().length <= 128)"
        },

        "players": {
          "$uid": {
            ".write": "auth != null && $uid === auth.uid",
            "nick": {
              ".validate": "newData.isString() && newData.val().length > 0 && newData.val().length <= 20"
            },
            "$other": { ".validate": true }
          }
        },

        "game": {
          "$uid": {
            ".write": "auth != null && $uid === auth.uid",
            ".validate": "newData.hasChildren(['x', 'y', 'z'])",
            "x": { ".validate": "newData.isNumber() && newData.val() >= -500 && newData.val() <= 500" },
            "y": { ".validate": "newData.isNumber() && newData.val() >= -100 && newData.val() <= 500" },
            "z": { ".validate": "newData.isNumber() && newData.val() >= -500 && newData.val() <= 500" },
            "r": { ".validate": "newData.isNumber()" },
            "n": { ".validate": "newData.isString() && newData.val().length <= 20" },
            "p": { ".validate": "newData.isString() && newData.val().length <= 24" },
            "role": { ".validate": "newData.val() === null || (newData.isString() && newData.val().matches(/^(seeker|hider)$/))" },
            "stuck": { ".validate": "newData.val() === null || newData.isNumber()" },
            "t": { ".validate": "newData.val() === null || newData.isNumber()" },
            "$other": { ".validate": true }
          }
        },

        "round": {
          "alive": {
            "$uid": {
              ".write": "auth != null",
              ".validate": "newData.isBoolean()"
            }
          },
          "scores": {
            "$uid": {
              ".write": "auth != null && $uid === auth.uid",
              ".validate": "newData.isNumber() && newData.val() >= 0 && newData.val() <= 999999"
            }
          },
          "$other": { ".validate": true }
        },

        "seekers": {
          "$uid": {
            ".write": "auth != null",
            ".validate": "newData.isBoolean()"
          }
        },

        "catches": {
          "$uid": {
            ".write": "auth != null",
            ".validate": "newData.isNumber() && newData.val() >= 0 && newData.val() <= 999"
          }
        },

        "paintSplats": {
          "$key": {
            ".write": "auth != null && !data.exists()",
            ".validate": "newData.hasChildren(['x','y','z']) && newData.child('x').isNumber() && newData.child('y').isNumber() && newData.child('z').isNumber()",
            "x": { ".validate": "newData.isNumber() && newData.val() >= -500 && newData.val() <= 500" },
            "y": { ".validate": "newData.isNumber() && newData.val() >= -100 && newData.val() <= 500" },
            "z": { ".validate": "newData.isNumber() && newData.val() >= -500 && newData.val() <= 500" },
            "$other": { ".validate": true }
          }
        },

        "chat": {
          "$key": {
            ".write": "auth != null && !data.exists()",
            ".validate": "newData.hasChildren(['nick','text','t']) && newData.child('nick').isString() && newData.child('nick').val().length <= 20 && newData.child('text').isString() && newData.child('text').val().length > 0 && newData.child('text').val().length <= 200 && newData.child('t').isNumber()",
            "$other": { ".validate": true }
          }
        },

        "whistles": {
          "$key": {
            ".write": "auth != null && !data.exists()",
            ".validate": "newData.hasChildren(['uid','t']) && newData.child('uid').isString() && newData.child('t').isNumber()"
          }
        },

        "decoys": {
          "$key": {
            ".write": "auth != null && ((!data.exists() && newData.child('owner').val() === auth.uid) || (data.exists() && data.child('owner').val() === auth.uid))",
            ".validate": "newData.hasChild('owner') && newData.child('owner').isString()"
          }
        },

        "paint": {
          "$uid": {
            ".write": "auth != null && $uid === auth.uid",
            "$key": {
              ".validate": true
            }
          }
        },

        "likes": {
          "$uid": {
            ".write": "auth != null",
            ".validate": "newData.isNumber() && newData.val() >= 0 && newData.val() <= 999"
          }
        },

        "votes": {
          "$uid": {
            ".write": "auth != null && $uid === auth.uid",
            ".validate": "newData.isNumber() && newData.val() >= 0 && newData.val() <= 20"
          }
        },
        "modeVotes": {
          "$uid": {
            ".write": "auth != null && $uid === auth.uid",
            ".validate": "newData.isString() && newData.val().length <= 16"
          }
        },

        "$other": {
          ".write": "auth != null && root.child('rooms').child($roomId).child('hostUid').val() === auth.uid"
        }
      }
    }
  }
}
