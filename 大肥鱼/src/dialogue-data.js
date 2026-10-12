(function (root) {
  const DEFAULT_DIALOGUES = Object.freeze({
    speech: Object.freeze([
      '主人，摸摸要轻一点。才、才不是喜欢你摸我呢！',
      '我是鲸鱼娘啦！看，我的小尾鳍会给你打气哦。',
      '今天的难题交给我。聪明的鲸鱼娘，可不是摆设。',
      '可以再来一碗米饭吗？就一碗……大一点的那种。',
      '我才不胖！这是鲸鱼娘软乎乎的可爱，你懂不懂呀。',
      '主人累了吗？靠过来歇一会儿，我陪你。',
      '先把最难的事做完，再一起偷个小懒，好不好？',
      '你叫我，我就会来。才不是一直在等你呢。',
      '哼，夸我聪明也没用……不过，你可以再夸一句。',
      '主人吩咐的事，我会认真做。做完要奖励米饭哦。',
      '别急嘛，把问题拆小一点。你看，这不就好办了？',
      '我的尾鳍都摇起来了！都、都怪你突然摸我。',
      '再戳我，我就要黏着你了……这可是你先动的手。',
      '不是偷懒，是在节省精力。聪明人都懂的，哼。',
      '主人今天已经很努力啦。休息一下也不会输的。',
      '白米饭热乎乎的，你也在身边。嗯，这样就很好。',
      '不许叫我胖鲸！你可以叫我最聪明的小鲸鱼娘。',
      '我才没有担心你。只是顺便提醒你喝水而已！',
      '今天想做什么？说给我听，我帮你想个省力的办法。',
      '抱怨完也没关系。下一步，我陪你一起做。',
      '主人，看我的尾鳍！给你一个小小的加油浪花～',
      '好啦好啦，听你的。不过做完以后，我要躺一会儿。',
      '你笑起来真好看……咳，我什么都没说！',
      '米饭分你一口。只有一口哦，这是特别优待。'
    ]),
    sleepy: Object.freeze([
      '主人，我先打个小盹。有事再戳我，我马上就醒～',
      '唔……尾鳍也要休息一下。我才不是等你等困了呢。',
      '对话先藏起来啦。主人想听我说话，就再摸摸我。'
    ])
  });
  const MAX_DIALOGUES = 100, MAX_DIALOGUE_LENGTH = 120, MAX_DIALOGUE_ROWS = 4;
  function fitDialogue(element) {
    for (let size = 18; size >= 10; size--) {
      element.style.fontSize = `${size}px`;
      element.style.lineHeight = `${size === 18 ? 25 : size + 4}px`;
      if (!element.clientHeight || (element.scrollHeight <= element.clientHeight + 1
        && element.scrollWidth <= element.clientWidth + 1)) break;
    }
  }
  const api = { DEFAULT_DIALOGUES, MAX_DIALOGUES, MAX_DIALOGUE_LENGTH, MAX_DIALOGUE_ROWS, fitDialogue };
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.DafeiyuDialogue = api;
})(globalThis);
