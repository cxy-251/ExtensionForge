'use strict';
const {
  Service
}=require("ee-core"),{
  app,dialog,BrowserWindow,session
}=require("electron"),axios=require("axios"),common=require("../common"),path=require("path"),fs=require('fs'),{
  download
}=require("electron-dl"),Services=require("ee-core/services"),Addon=require("ee-core/addon"),cookie=require("cookie");
class XhsService extends Service{
  constructor(_0x18c749){
    super(_0x18c749),this.isInterrupt=![],this.headers=[],this.tasks=[];
  }async.openCollectionWindow(_0x21f303){
    this.tasks=[],Services.get("collection").setListener({
      'urlInterceptor':async _0x3cab87=>{
        if(_0x3cab87.includes("xhslink.com"))try{
          const _0xe18c0c=await axios.get(_0x3cab87,{
            'timeout':10000,'headers':{
              'Host':"xhslink.com"
            },'maxRedirects':0,'validateStatus':_0x37fc62=>{
              return _0x37fc62>=200&&_0x37fc62<400;
            }
          });
          if(_0xe18c0c.status>=300&&_0xe18c0c.status<400&&_0xe18c0c.headers.location)_0x3cab87=_0xe18c0c.headers.location;
        }catch(_0x4bbe96){
        }return _0x3cab87;
      },'onBeforeSendHeaders':(_0x4354f4,_0x414da3)=>{
        new Promise(async _0x3eb7af=>{
          if(_0x21f303.type==="home"&&_0x414da3.url.includes("/user/profile/"))for(let _0x515938=0;
          _0x515938<10;
          _0x515938++){
            try{
              const _0x5db6f3=await _0x4354f4.webContents.executeJavaScript("function getTest() {return JSON.stringify(window.__INITIAL_STATE__.user.notes._rawValue[0]);}getTest();");
              if(_0x5db6f3){
                const _0x9ab8f=JSON.parse(_0x5db6f3);
                this.headers=_0x414da3.requestHeaders;
                const _0x4dacd9=cookie.parse(_0x414da3.requestHeaders.Cookie),_0x35c499=await _0x4354f4.webContents.executeJavaScript("function getTest() {return localStorage.getItem('b1');}getTest();");
                for(const _0x4062e2 of _0x9ab8f){
                  if(!_0x4062e2['id']||!_0x4062e2.xsecToken||!_0x4dacd9['a1']||!_0x35c499)continue;
                  const _0x19dc89=await _0x4354f4.webContents.executeJavaScript("\n                                            function getTest() {\n                                               return JSON.stringify(window._webmsxyw('/api/sns/web/v1/feed', {\n                                                    \"source_note_id\": \""+_0x4062e2['id']+"\",\n                                                    \"image_formats\": [\n                                                        \"jpg\",\n                                                        \"webp\",\n                                                        \"avif\"\n                                                    ],\n                                                    \"extra\": {\n                                                        \"need_body_topic\": \"1\"\n                                                    },\n                                                    \"xsec_source\": \"pc_user\",\n                                                    \"xsec_token\": \""+_0x4062e2.xsecToken+"\"\n                                                }));\n                                            }\n                                            getTest();\n                                        "),_0x2e2369=JSON.parse(_0x19dc89),_0x3a3bbf=common.pkgTask("undefined",_0x4062e2['id'],_0x4062e2.noteCard.displayTitle,'',_0x4062e2.noteCard.interactInfo.likedCount,'-','-','-');
                  this.tasks[_0x3a3bbf['id']]={
                    'title':_0x3a3bbf.title,'poster':void 0,'urls':[],'xsecToken':_0x4062e2.xsecToken,'a1':_0x4dacd9['a1'],'b1':_0x35c499,'xt':_0x2e2369["X-t"],'xs':_0x2e2369["X-s"]
                  },_0x3a3bbf.title=_0x3a3bbf.title.length>=50?_0x3a3bbf.title.substring(0,50):_0x3a3bbf.title,common.noticeCollectedTask(this.app,_0x3a3bbf);
                }break;
              }
            }catch(_0x25b267){
              console.log(_0x25b267);
            }await common.sleep(1000);
          }else{
            if(_0x21f303.type==="home"&&_0x414da3.url.includes("v1/user_posted")){
              if(!_0x414da3.requestHeaders.Cookie){
                _0x3eb7af();
                return;
              }delete _0x414da3.requestHeaders["x-b3-traceid"],this.headers=_0x414da3.requestHeaders;
              const _0x9d1562=cookie.parse(_0x414da3.requestHeaders.Cookie),_0x1569fe=await _0x4354f4.webContents.executeJavaScript("function getTest() {return localStorage.getItem('b1');}getTest();");
              for(let _0x3c9b68=0;
              _0x3c9b68<5;
              _0x3c9b68++){
                try{
                  const _0x167574=await axios.get(_0x414da3.url,{
                    'timeout':10000,'headers':_0x414da3.requestHeaders
                  });
                  for(const _0xe79c31 of _0x167574.data.data.notes){
                    const _0x1f304d=await _0x4354f4.webContents.executeJavaScript("\n                                            function getTest() {\n                                               return JSON.stringify(window._webmsxyw('/api/sns/web/v1/feed', {\n                                                    \"source_note_id\": \""+_0xe79c31.note_id+"\",\n                                                    \"image_formats\": [\n                                                        \"jpg\",\n                                                        \"webp\",\n                                                        \"avif\"\n                                                    ],\n                                                    \"extra\": {\n                                                        \"need_body_topic\": \"1\"\n                                                    },\n                                                    \"xsec_source\": \"pc_user\",\n                                                    \"xsec_token\": \""+_0xe79c31.xsec_token+"\"\n                                                }));\n                                            }\n                                            getTest();\n                                        "),_0x1dfcda=JSON.parse(_0x1f304d),_0x4c2821=common.pkgTask("undefined",_0xe79c31.note_id,_0xe79c31.display_title,'','-','-','-','-');
                    this.tasks[_0x4c2821['id']]={
                      'title':_0x4c2821.title,'poster':void 0,'urls':[],'xsecToken':_0xe79c31.xsec_token,'a1':_0x9d1562['a1'],'b1':_0x1569fe,'xt':_0x1dfcda["X-t"],'xs':_0x1dfcda["X-s"]
                    },_0x4c2821.title=_0x4c2821.title.length>=50?_0x4c2821.title.substring(0,50):_0x4c2821.title,common.noticeCollectedTask(this.app,_0x4c2821);
                  }break;
                }catch(_0x51d61b){
                  console.log(_0x51d61b);
                }await common.sleep(1000);
              }
            }else{
              if(_0x21f303.type==="solo"&&_0x414da3.url.includes("explore/")||_0x21f303.type==="solo"&&_0x414da3.url.includes("discovery/")||_0x21f303.type==="solo"&&_0x414da3.url.includes("?source=webshare"))for(let _0x1c66f4=0;
              _0x1c66f4<10;
              _0x1c66f4++){
                try{
                  const _0x5d01bb=await _0x4354f4.webContents.executeJavaScript("function getTest() {return JSON.stringify(window.__INITIAL_STATE__.note.noteDetailMap);}getTest();");
                  if(_0x5d01bb){
                    const _0xcaed83=JSON.parse(_0x5d01bb);
                    if(_0xcaed83)for(const _0x1fae70 in _0xcaed83){
                      if(_0x1fae70==='')continue;
                      common.noticeCollectedTask(this.app,this.handleNote(_0xcaed83[_0x1fae70].note)),_0x3eb7af();
                      return;
                    }
                  }break;
                }catch(_0x7461ef){
                }await common.sleep(1000);
              }
            }
          }_0x3eb7af();
        });
      },'onDidFinishLoad':_0x13ec2d=>{
        _0x13ec2d.webContents.executeJavaScript("\n                      const div1 = document.createElement('div');\n                      div1.style.position = 'fixed';\n                      div1.style.top = '10px';\n                      div1.style.left = '10px';\n                      div1.style.background = 'rgba(0, 0, 0, 0.5)';\n                      div1.style.color = 'red';\n                      div1.style.fontWeight = 'bold';\n                      div1.style.fontSize = '20px';\n                      div1.style.zIndex = '999999';\n                      div1.textContent = '请登录小红书，未登录无法浏览作者主页列表中的作品(已登录请忽略)';\n                      document.body.appendChild(div1);\n                      const div2 = document.createElement('div');\n                      div2.style.position = 'fixed';\n                      div2.style.top = '40px';\n                      div2.style.left = '10px';\n                      div2.style.background = 'rgba(0, 0, 0, 0.5)';\n                      div2.style.color = 'blue';\n                      div2.style.fontWeight = 'bold';\n                      div2.style.fontSize = '20px';\n                      div2.style.zIndex = '999999';\n                      div2.textContent = '如果弹出验证码请手动完成验证否则无法采集笔记';\n                      document.body.appendChild(div2);\n                      const div3 = document.createElement('div');\n                      div3.id = 'myDiv';\n                      div3.style.position = 'fixed';\n                      div3.style.top = '80px';\n                      div3.style.left = '10px';\n                      div3.style.background = 'rgba(0, 0, 0, 0.5)';\n                      div3.style.color = 'yellow';\n                      div3.style.fontWeight = 'bold';\n                      div3.style.fontSize = '20px';\n                      div3.style.zIndex = '999999';\n                      div3.textContent = '下载主页的笔记，您必须先登录。如果您尚未登录，请先完成登录流程，随后关闭当前窗口，并重新点击下载按钮以打开新的采集窗口。';\n                      document.body.appendChild(div3);\n                      const div4 = document.createElement('div');\n                      div4.id = 'dydTip4';\n                      div4.style.position = 'fixed';\n                      div4.style.top = '150px';\n                      div4.style.left = '10px';\n                      div4.style.background = 'rgba(0, 0, 0, 0.5)';\n                      div4.style.color = 'yellow';\n                      div4.style.fontWeight = 'bold';\n                      div4.style.fontSize = '20px';\n                      div4.style.zIndex = '999999';\n                      div4.textContent = '点击我关闭提示';\n                      document.body.appendChild(div4);\n                      dydTip4.addEventListener('click', () => {\n                         div1.remove();\n                         div2.remove();\n                         div3.remove();\n                         div4.remove();\n                      });\n                ");
      }
    }),Services.get("collection").open(_0x21f303.url);
  }async.downloadU(_0x347ed9){
    let _0xbf2128=0;
    for(let _0x7c7aa0=0;
    _0x7c7aa0<5;
    _0x7c7aa0++){
      if(this.isInterrupt)return common.noticeDownloadProgress(this.app,_0x347ed9,-999);
      try{
        common.noticeDownloadProgress(this.app,_0x347ed9,1);
        const _0x4c26fc=await axios.post("https://ci.ak47.ink/Dyd/xscommon",{
          'a1':this.tasks[_0x347ed9.task['id']]['a1'],'b1':this.tasks[_0x347ed9.task['id']]['b1'],'xt':this.tasks[_0x347ed9.task['id']]['xt'],'xs':this.tasks[_0x347ed9.task['id']]['xs'],'sign':common.md5(this.tasks[_0x347ed9.task['id']]['xs']+"dyd")
        },{
          'timeout':10000
        });
        if(!_0x4c26fc.data.xsc)return common.noticeDownloadProgress(this.app,_0x347ed9,-55,null,"签名服务器繁忙("+(_0x7c7aa0+1)+')');
        this.tasks[_0x347ed9.task['id']].xsc=_0x4c26fc.data.xsc;
      }catch(_0x52eb6b){
        console.log(_0x52eb6b);
        continue;
      }try{
        const _0x197bb4=await axios.post(++_0xbf2128>=3?"https://ci.ak47.ink/Dyd/xNoteDetail":"https://edith.xiaohongshu.com/api/sns/web/v1/feed",{
          'source_note_id':_0x347ed9.task['id'],'image_formats':["jpg","webp","avif"],'extra':{
            'need_body_topic':'1'
          },'xsec_source':"pc_user",'xsec_token':this.tasks[_0x347ed9.task['id']].xsecToken
        },{
          'headers':{
            'X-t':this.tasks[_0x347ed9.task['id']]['xt'],'X-s':this.tasks[_0x347ed9.task['id']]['xs'],'X-S-Common':this.tasks[_0x347ed9.task['id']].xsc,'Cookie':this.headers.Cookie,'Host':"edith.xiaohongshu.com",'Connection':"keep-alive",'sec-ch-ua':"\"Not/A)Brand\";v=\"8\", \"Chromium\";v=\"126\", \"Google Chrome\";v=\"126\"",'sec-ch-ua-mobile':'?0','User-Agent':"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",'Accept':"application/json, text/plain, *!/!*",'sec-ch-ua-platform':"Windows",'Origin':"https://www.xiaohongshu.com",'Sec-Fetch-Site':"same-site",'Sec-Fetch-Mode':"cors",'Sec-Fetch-Dest':"empty",'Referer':" https://www.xiaohongshu.com/",'Accept-Encoding':"gzip, deflate, br, zstd",'Accept-Language':"zh-CN,zh;q=0.9,en-US;q=0.8,en;q=0.7"
          }
        });
        console.log(_0x197bb4.data);
        const _0x2b755c={
          'idx':_0x347ed9.idx,'task':this.handleNote(_0x197bb4.data.data.items[0].note_card)
        };
        this.tasks[_0x2b755c.task['id']].title=_0x2b755c.task.title,delete _0x2b755c.task.title,common.noticeUpdateTask(this.app,_0x2b755c);
        switch(_0x2b755c.task.downloadType){
          case "images":return this.downloadI({
            ..._0x2b755c,'settings':_0x347ed9.settings
          });
          case "video":return this.downloadV({
            ..._0x2b755c,'settings':_0x347ed9.settings
          });
        }return;
      }catch(_0x334438){
        common.noticeDownloadProgress(this.app,_0x347ed9,-53,null,"无法获取笔记信息("+(_0x7c7aa0+1)+')');
      }await common.sleep(1000);
    }common.noticeDownloadProgress(this.app,_0x347ed9,-999,null,"下载失败");
  }async.downloadI(_0x40f930){
    if(!this.tasks[_0x40f930.task['id']]||this.tasks[_0x40f930.task['id']].urls.length===0){
      common.noticeDownloadProgress(this.app,_0x40f930,-999);
      return;
    }_0x40f930.task.title=this.tasks[_0x40f930.task['id']].title,common.prepare(_0x40f930,"xhs"),Addon.get("axDownloader").download(this.tasks[_0x40f930.task['id']].urls,{
      'outDir':_0x40f930.outDir,'skipDownloaded':!![],'nameFactory':_0xe47c99=>{
        return _0x40f930.settings.imageUseTit?_0x40f930.filterFileName+_0xe47c99+".jpg":_0xe47c99+".jpg";
      },'onProgress':_0x3ca699=>{
        common.noticeDownloadProgress(this.app,_0x40f930,_0x3ca699.rate,null);
      }
    }).then(_0x2da27c=>{
      common.noticeDownloadProgress(this.app,_0x40f930,100,_0x2da27c.outDir);
    }).catch(_0x214aa4=>{
      common.noticeDownloadProgress(this.app,_0x40f930,-999);
    });
  }async.downloadV(_0x5af611){
    let _0x464638=this.tasks[_0x5af611.task['id']].urls.length>0?this.tasks[_0x5af611.task['id']].urls.splice(0,1)[0]:null;
    if(!_0x464638)return common.noticeDownloadProgress(this.app,_0x5af611,-999);
    _0x5af611.task.title=this.tasks[_0x5af611.task['id']].title,common.prepare(_0x5af611,"xhs");
    if(_0x5af611.settings.poster)Addon.get("axDownloader").download(this.tasks[_0x5af611.task['id']].poster,{
      'outPath':_0x5af611.absolutePath+".jpg",'skipDownloaded':!![]
    });
    fs.existsSync(path.join(_0x5af611.outDir,_0x5af611.filterFileName+".mp4"))?common.noticeDownloadProgress(this.app,_0x5af611,100,path.join(_0x5af611.outDir,_0x5af611.filterFileName+".mp4").toString()):download(this.app.mainWindow,_0x464638,{
      'directory':_0x5af611.outDir,'filename':_0x5af611.filterFileName+".mp4",'onStarted':_0x5467fe=>this.downloadItem=_0x5467fe,'onProgress':_0x4b2bc3=>{
        let _0x474818=parseInt(_0x4b2bc3.percent*100);
        common.noticeDownloadProgress(this.app,_0x5af611,_0x474818);
      }
    }).then(_0x3d9cde=>{
      common.noticeDownloadProgress(this.app,_0x5af611,100,_0x3d9cde.getSavePath());
    }).catch(async _0x1057f1=>{
      return this.isInterrupt?(this.tasks[_0x5af611.task['id']].urls.push(_0x464638),common.noticeDownloadProgress(this.app,_0x5af611,-998,null,"下载失败：手动中止")):(_0x5af611.retryCounter=_0x5af611.retryCounter||1,common.noticeDownloadProgress(this.app,_0x5af611,_0x5af611.retryCounter++),this.downloadV(_0x5af611));
    });
  }async.interruptDownload(_0x46126f){
    try{
      this.isInterrupt=_0x46126f.state,this.isInterrupt&&(Addon.get("axDownloader").cancel(),this.downloadItem.cancel());
    }catch(_0x47c388){
    }
  }.handleNote(_0x4b0521){
    try{
      let _0x4f846d=null;
      if(_0x4b0521.interact_info)return _0x4f846d=common.pkgTask(_0x4b0521.video?"video":"images",_0x4b0521.note_id,_0x4b0521.desc||_0x4b0521.title,_0x4b0521.user.nickname,_0x4b0521.interact_info.liked_count,_0x4b0521.interact_info.comment_count,_0x4b0521.interact_info.share_count,_0x4b0521.time/1000),_0x4b0521.video?(this.tasks[_0x4f846d['id']].poster=_0x4b0521.image_list[0].urlPre||_0x4b0521.image_list[0].url_pre,this.tasks[_0x4f846d['id']].urls.push("https://sns-video-bd.xhscdn.com/"+_0x4b0521.video.consumer.origin_video_key)):this.tasks[_0x4f846d['id']].urls=_0x4b0521.image_list.map(_0x3fd29d=>_0x3fd29d.url_default),_0x4f846d;
      else{
        if(_0x4b0521.interactInfo){
          _0x4f846d=common.pkgTask(_0x4b0521.video?"video":"images",_0x4b0521.noteId,_0x4b0521.desc||_0x4b0521.title,_0x4b0521.user.nickname,_0x4b0521.interactInfo.likedCount,_0x4b0521.interactInfo.commentCount,_0x4b0521.interactInfo.shareCount,_0x4b0521.time/1000);
          if(!this.tasks[_0x4f846d['id']])this.tasks[_0x4f846d['id']]={
            'title':_0x4f846d.title,'poster':void 0,'urls':[]
          };
          return _0x4b0521.video?(this.tasks[_0x4f846d['id']].poster=_0x4b0521.imageList[0].urlPre,this.tasks[_0x4f846d['id']].urls.push("https://sns-video-bd.xhscdn.com/"+_0x4b0521.video.consumer.originVideoKey)):this.tasks[_0x4f846d['id']].urls=_0x4b0521.imageList.map(_0x360a6b=>_0x360a6b.urlDefault),_0x4f846d;
        }
      }
    }catch(_0x152323){
      console.log(_0x152323);
    }return null;
  }
}XhsService.toString=()=>"[class XhsService]",module.exports=XhsService;
