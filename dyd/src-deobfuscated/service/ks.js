'use strict';
const {
  Service
}=require("ee-core"),{
  app,dialog,BrowserWindow,session
}=require("electron"),axios=require("axios"),common=require("../common"),path=require("path"),fs=require('fs'),{
  download
}=require("electron-dl"),Services=require("ee-core/services"),Addon=require("ee-core/addon");
class KsService extends Service{
  constructor(_0x4126fb){
    super(_0x4126fb),this.isInterrupt=![],this.headers=[],this.tasks=[];
  }async.openCollectionWindow(_0x23254e){
    this.tasks=[],Services.get("collection").setListener({
      'onBeforeSendHeaders':(_0x456cb8,_0x5ef874)=>{
        if(_0x5ef874.requestHeaders.Referer)_0x5ef874.requestHeaders.Referer+="?r="+Math.random().toString(16).substring(0,6);
        new Promise(async _0x5b883c=>{
          if(_0x23254e.type==="home"&&_0x5ef874.url.includes("com/graphql")&&_0x5ef874.uploadData&&_0x5ef874.uploadData[0].bytes.toString().includes("photoContent on PhotoEntity"))for(let _0x1bf475=0;
          _0x1bf475<5;
          _0x1bf475++){
            try{
              delete _0x5ef874.requestHeaders["Accept-Encoding"],this.headers=_0x5ef874.requestHeaders;
              const _0x1fa063=await axios.post(_0x5ef874.url,_0x5ef874.uploadData[0].bytes.toString(),{
                'headers':_0x5ef874.requestHeaders,'timeout':10000
              });
              _0x1fa063.data.data.visionProfilePhotoList.feeds.forEach(_0x18bc9b=>this.handleFeed(_0x18bc9b,101));
              break;
            }catch(_0x1f92c0){
              console.log(_0x1f92c0);
            }
          }else{
            if(_0x23254e.type==="solo"&&_0x5ef874.url.includes("short-video")||_0x23254e.type==="solo"&&_0x5ef874.url.includes("com/f/"))for(let _0x329e90=0;
            _0x329e90<10;
            _0x329e90++){
              try{
                const _0x14cab4=await _0x456cb8.webContents.executeJavaScript("function getTest() {return JSON.stringify(window.__APOLLO_STATE__.defaultClient);}getTest();");
                if(_0x14cab4){
                  const _0x3b58e1=JSON.parse(_0x14cab4);
                  let _0x539097=null,_0x45645f=null;
                  for(const _0x1ddf55 in _0x3b58e1){
                    if(_0x1ddf55.includes("VisionVideoDetailAuthor"))_0x539097=_0x3b58e1[_0x1ddf55];
                    if(_0x1ddf55.includes("VisionVideoDetailPhoto")&&_0x3b58e1[_0x1ddf55].caption)_0x45645f=_0x3b58e1[_0x1ddf55];
                  }if(_0x539097&&_0x45645f)this.handleFeed({
                    'feed':_0x45645f,'author':_0x539097
                  },102);
                }break;
              }catch(_0x281275){
                console.log(_0x281275);
              }await common.sleep(1000);
            }else{
              if(_0x23254e.type==="home"&&_0x5ef874.url.includes("profile/public?"))for(let _0x2c26d2=0;
              _0x2c26d2<5;
              _0x2c26d2++){
                try{
                  delete _0x5ef874.requestHeaders["Accept-Encoding"],this.headers=_0x5ef874.requestHeaders;
                  const _0x199134=await axios.get(_0x5ef874.url,{
                    'headers':_0x5ef874.requestHeaders,'timeout':10000
                  });
                  _0x199134.data.data.list.forEach(_0x2f05e6=>this.handleFeed(_0x2f05e6,103));
                  break;
                }catch(_0x319ed7){
                  console.log(_0x319ed7);
                }
              }else{
                if(_0x23254e.type==="solo"&&_0x5ef874.url.includes("profile/feedbyid?photoId"))for(let _0x4321e2=0;
                _0x4321e2<5;
                _0x4321e2++){
                  try{
                    delete _0x5ef874.requestHeaders["Accept-Encoding"],this.headers=_0x5ef874.requestHeaders;
                    const _0xe1eda4=await axios.get(_0x5ef874.url,{
                      'headers':_0x5ef874.requestHeaders,'timeout':10000
                    });
                    this.handleFeed(_0xe1eda4.data.data.currentWork,103);
                    break;
                  }catch(_0x7debbc){
                    console.log(_0x7debbc);
                  }
                }else{
                  if(_0x23254e.type==="solo"&&_0x5ef874.url.includes("chenzhongtech")&&_0x5ef874.url.includes("photo/info"))for(let _0x5c14ce=0;
                  _0x5c14ce<5;
                  _0x5c14ce++){
                    try{
                      delete _0x5ef874.requestHeaders["Accept-Encoding"],this.headers=_0x5ef874.requestHeaders;
                      const _0x41ec9d=await axios.post(_0x5ef874.url,_0x5ef874.uploadData[0].bytes.toString(),{
                        'headers':_0x5ef874.requestHeaders,'timeout':10000
                      });
                      this.handleFeed(_0x41ec9d.data,104);
                      break;
                    }catch(_0x4ac371){
                      console.log(_0x4ac371);
                    }
                  }
                }
              }
            }
          }_0x5b883c();
        });
      },'onDidFinishLoad':_0x4d2472=>{
        _0x4d2472.webContents.executeJavaScript("\n                      const div1 = document.createElement('div');\n                      div1.id = 'dydTip1';\n                      div1.style.position = 'fixed';\n                      div1.style.top = '10px';\n                      div1.style.left = '10px';\n                      div1.style.background = 'rgba(0, 0, 0, 0.5)';\n                      div1.style.color = 'red';\n                      div1.style.fontWeight = 'bold';\n                      div1.style.fontSize = '20px';\n                      div1.style.zIndex = '999999';\n                      div1.textContent = '请登录快手，未登录只能采集前20个作品(已登录请忽略)';\n                      document.body.appendChild(div1);\n                      const div2 = document.createElement('div');\n                      div2.id = 'dydTip2';\n                      div2.style.position = 'fixed';\n                      div2.style.top = '40px';\n                      div2.style.left = '10px';\n                      div2.style.background = 'rgba(0, 0, 0, 0.5)';\n                      div2.style.color = 'blue';\n                      div2.style.fontWeight = 'bold';\n                      div2.style.fontSize = '20px';\n                      div2.style.zIndex = '999999';\n                      div2.textContent = '如果弹出验证码请手动完成验证否则无法采集作品';\n                      document.body.appendChild(div2);\n                      const div3 = document.createElement('div');\n                      div3.id = 'dydTip3';\n                      div3.style.position = 'fixed';\n                      div3.style.top = '80px';\n                      div3.style.left = '10px';\n                      div3.style.background = 'rgba(0, 0, 0, 0.5)';\n                      div3.style.color = 'yellow';\n                      div3.style.fontWeight = 'bold';\n                      div3.style.fontSize = '20px';\n                      div3.style.zIndex = '999999';\n                      div3.textContent = '点击我关闭提示';\n                      document.body.appendChild(div3);\n                      dydTip3.addEventListener('click', () => {\n                         div1.remove();\n                         div2.remove();\n                         div3.remove();\n                      });\n                ");
      }
    }),Services.get("collection").open(_0x23254e.url);
  }async.downloadI(_0x4be678){
    if(!this.tasks[_0x4be678.task['id']]||this.tasks[_0x4be678.task['id']].urls.length===0){
      common.noticeDownloadProgress(this.app,_0x4be678,-999);
      return;
    }_0x4be678.task.title=this.tasks[_0x4be678.task['id']].title,common.prepare(_0x4be678,'ks'),Addon.get("axDownloader").download(this.tasks[_0x4be678.task['id']].urls,{
      'outDir':_0x4be678.outDir,'skipDownloaded':!![],'nameFactory':_0x5645af=>{
        return _0x4be678.settings.imageUseTit?_0x4be678.filterFileName+_0x5645af+".jpg":_0x5645af+".jpg";
      },'onProgress':_0x13f32d=>{
        common.noticeDownloadProgress(this.app,_0x4be678,_0x13f32d.rate,null);
      }
    }).then(_0x202c45=>{
      common.noticeDownloadProgress(this.app,_0x4be678,100,_0x202c45.outDir);
    }).catch(_0x47f67f=>{
      common.noticeDownloadProgress(this.app,_0x4be678,-999);
    });
  }async.downloadV(_0x243dfe){
    let _0x2b0d7f=this.tasks[_0x243dfe.task['id']].urls.length>0?this.tasks[_0x243dfe.task['id']].urls.splice(0,1)[0]:null;
    if(!_0x2b0d7f)return common.noticeDownloadProgress(this.app,_0x243dfe,-999);
    if(this.tasks[_0x243dfe.task['id']].title)_0x243dfe.task.title=this.tasks[_0x243dfe.task['id']].title;
    common.prepare(_0x243dfe,'ks');
    if(_0x243dfe.settings.poster)Addon.get("axDownloader").download(this.tasks[_0x243dfe.task['id']].poster,{
      'outPath':_0x243dfe.absolutePath+".jpg",'skipDownloaded':!![]
    });
    fs.existsSync(path.join(_0x243dfe.outDir,_0x243dfe.filterFileName+".mp4"))?common.noticeDownloadProgress(this.app,_0x243dfe,100,path.join(_0x243dfe.outDir,_0x243dfe.filterFileName+".mp4").toString()):download(this.app.mainWindow,_0x2b0d7f,{
      'directory':_0x243dfe.outDir,'filename':_0x243dfe.filterFileName+".mp4",'onStarted':_0x3d6132=>this.downloadItem=_0x3d6132,'onProgress':_0x4468f1=>{
        let _0x148d38=parseInt(_0x4468f1.percent*100);
        common.noticeDownloadProgress(this.app,_0x243dfe,_0x148d38);
      }
    }).then(_0x2a04fa=>{
      common.noticeDownloadProgress(this.app,_0x243dfe,100,_0x2a04fa.getSavePath());
    }).catch(async _0x348b71=>{
      return this.isInterrupt?(this.tasks[_0x243dfe.task['id']].urls.push(_0x2b0d7f),common.noticeDownloadProgress(this.app,_0x243dfe,-998,null,"下载失败：手动中止")):(_0x243dfe.retryCounter=_0x243dfe.retryCounter||1,common.noticeDownloadProgress(this.app,_0x243dfe,_0x243dfe.retryCounter++),this.downloadV(_0x243dfe));
    });
  }async.interruptDownload(_0x4d2465){
    try{
      this.isInterrupt=_0x4d2465.state,this.isInterrupt&&(Addon.get("axDownloader").cancel(),this.downloadItem.cancel());
    }catch(_0x4fc1b6){
    }
  }.handleFeed(_0x12d767,_0x509c76){
    try{
      if(_0x509c76===101){
        const _0xdd41d=common.pkgTask(_0x12d767.photo.duration?"video":"images",_0x12d767.photo['id'],_0x12d767.photo.caption,_0x12d767.author.name,_0x12d767.photo.realLikeCount,0,0,_0x12d767.photo.timestamp/1000);
        this.tasks[_0xdd41d['id']]={
          'title':_0xdd41d.title,'poster':void 0,'urls':[]
        },_0xdd41d.title=_0xdd41d.title.length>=50?_0xdd41d.title.substring(0,50):_0xdd41d.title;
        if(_0x12d767.photo.duration){
          this.tasks[_0xdd41d['id']].poster=_0x12d767.photo.coverUrl;
          if(_0x12d767.photo.photoH265Url)this.tasks[_0xdd41d['id']].urls.push(_0x12d767.photo.photoH265Url);
          if(_0x12d767.photo.photoUrl)this.tasks[_0xdd41d['id']].urls.push(_0x12d767.photo.photoUrl);
        }else{
        }common.noticeCollectedTask(this.app,_0xdd41d);
      }else{
        if(_0x509c76===102){
          const _0x269f93=common.pkgTask(_0x12d767.feed.duration?"video":"images",_0x12d767.feed['id'],_0x12d767.feed.caption,_0x12d767.author.name,_0x12d767.feed.realLikeCount,0,0,_0x12d767.feed.timestamp/1000);
          this.tasks[_0x269f93['id']]={
            'title':_0x269f93.title,'poster':void 0,'urls':[]
          },_0x269f93.title=_0x269f93.title.length>=50?_0x269f93.title.substring(0,50):_0x269f93.title;
          if(_0x12d767.feed.duration){
            this.tasks[_0x269f93['id']].poster=_0x12d767.feed.coverUrl;
            if(_0x12d767.feed.photoH265Url)this.tasks[_0x269f93['id']].urls.push(_0x12d767.feed.photoH265Url);
            if(_0x12d767.feed.photoUrl)this.tasks[_0x269f93['id']].urls.push(_0x12d767.feed.photoUrl);
            common.noticeCollectedTask(this.app,_0x269f93);
          }else{
          }
        }else{
          if(_0x509c76===103){
            const _0x3f3100=common.pkgTask(_0x12d767.imgUrls.length?"images":"video",_0x12d767['id'],'',_0x12d767.author.name,_0x12d767.counts.displayLike,0,0,Math.floor(new Date().getTime()/1000));
            this.tasks[_0x3f3100['id']]={
              'title':_0x3f3100.title,'poster':void 0,'urls':[]
            },_0x12d767.imgUrls.length?this.tasks[_0x3f3100['id']].urls=_0x12d767.imgUrls:this.tasks[_0x3f3100['id']].urls.push(_0x12d767.playUrl),console.log(_0x3f3100),common.noticeCollectedTask(this.app,_0x3f3100);
          }else{
            if(_0x509c76===104){
              if(_0x12d767.atlas.list.length){
                const _0x2251f0="https://"+_0x12d767.atlas.cdn[0],_0x47b126=common.pkgTask("images",_0x12d767.photo.photoId,_0x12d767.shareInfo.shareTitle,_0x12d767.photo.userName,_0x12d767.counts.followCount,0,0,Math.floor(_0x12d767.photo.timestamp/1000));
                this.tasks[_0x47b126['id']]={
                  'title':_0x47b126.title,'poster':void 0,'urls':_0x12d767.atlas.list.map(_0x477303=>_0x2251f0+_0x477303)
                },common.noticeCollectedTask(this.app,_0x47b126);
              }
            }
          }
        }
      }
    }catch(_0x36a9f6){
      console.log(_0x36a9f6);
    }
  }
}KsService.toString=()=>"[class KsService]",module.exports=KsService;
